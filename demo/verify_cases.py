"""Check planning-fixture arithmetic only; this is not a running agent/app test."""

import copy
import json
import math
from pathlib import Path


def trace(opening, events):
    ids = [event["id"] for event in events]
    assert len(ids) == len(set(ids)), "Duplicate event IDs"
    positions = [(event["day"], event["sequence"]) for event in events]
    assert len(positions) == len(set(positions)), "Ambiguous intraday order"
    balance = opening
    minimum = opening
    for event in sorted(events, key=lambda item: (item["day"], item["sequence"])):
        assert isinstance(event["amountMinor"], int)
        balance += event["amountMinor"]
        minimum = min(minimum, balance)
    return minimum, balance


def main():
    data = json.loads(Path(__file__).with_name("cases.json").read_text())
    checks = 0

    personal = data["phoneAndHome"]
    expected = personal["expected"]
    target = sum(personal[key] for key in (
        "homeDepositMinor", "closingAndMovingMinor", "protectedReserveMinor"
    ))
    assert target == expected["homeTargetMinor"]
    assert target - personal["openingCashMinor"] == expected["homeGapMinor"]
    checks += 2
    for cost_key, answer in (
        (None, "contributionsWithoutPhone"),
        ("phonePriceMinor", "contributionsWithPhone"),
        ("alternativePhonePriceMinor", "contributionsWithAlternativePhone"),
    ):
        cost = personal[cost_key] if cost_key else 0
        gap = max(0, target - personal["openingCashMinor"] + cost)
        months = math.ceil(gap / personal["monthlySavingsBeforeHomeMinor"])
        assert months == expected[answer], answer
        checks += 1
    residual = personal["monthlyIncomeMinor"] - personal["monthlyOtherSpendingMinor"] - personal["mockQuotedMortgagePaymentMinor"]
    assert residual == expected["monthlyAfterHomeMinor"]
    assert residual - personal["downsideIncomeReductionMinor"] == expected["downsideMonthlyAfterHomeMinor"]
    checks += 2

    business = data["businessOrder"]
    inventory = business["inventory"]
    units = max(0, inventory["requiredUnits"] - inventory["onHandUnits"])
    assert units == inventory["expectedPurchaseUnits"]
    assert units * inventory["unitMaterialCostMinor"] == inventory["expectedPurchaseCostMinor"]
    checks += 2
    scenarios = {item["id"]: item for item in business["scenarios"]}
    for scenario in scenarios.values():
        minimum, final = trace(business["openingCashMinor"], scenario["events"])
        assert minimum == scenario["expected"]["minimumCashMinor"], scenario["id"]
        assert final == scenario["expected"]["finalCashMinor"], scenario["id"]
        assert (minimum >= business["businessReserveMinor"]) == scenario["expected"]["feasible"]
        owner_events = [e for e in scenario["events"] if e["id"] == business["ownerTransferId"]]
        assert len(owner_events) == 1 and owner_events[0]["amountMinor"] == -400000
        checks += 4
        print(f'{scenario["id"]}: min={minimum / 100:,.0f} RON, final={final / 100:,.0f} RON')

    for offer in business["mockFundingOffers"]:
        events = copy.deepcopy(scenarios["partial_reply"]["events"])
        events += [
            {"id": "funding-draw", "day": offer["drawDay"], "sequence": 1, "amountMinor": offer["drawMinor"]},
            {"id": "funding-repayment", "day": offer["repayDay"], "sequence": offer["repaySequence"], "amountMinor": -offer["drawMinor"] - offer["feeMinor"]},
        ]
        minimum, final = trace(business["openingCashMinor"], events)
        assert minimum == offer["expectedMinimumCashMinor"]
        assert final == offer["expectedFinalCashMinor"]
        checks += 2
        print(f'{offer["id"]} (conditional): min={minimum / 100:,.0f} RON, final={final / 100:,.0f} RON')
        if offer["id"] == "offer-a":
            assert final - business["expectedFinalCashBaselineMinor"] == 1590000
            checks += 1
            # Same cash totals, different intraday order: the plan must fail the floor.
            earlier_repayment = copy.deepcopy(events)
            for event in earlier_repayment:
                if event["id"] == "funding-repayment":
                    event["sequence"] = 0
            early_min, early_final = trace(business["openingCashMinor"], earlier_repayment)
            assert early_min == 390000 and early_min < business["businessReserveMinor"]
            assert early_final == final
            checks += 2

    household = business["householdLinkedEvents"]
    _, household_final = trace(0, household)
    assert household_final == 50000
    transfer_in = sum(e["amountMinor"] for e in household if e["id"] == business["ownerTransferId"])
    transfer_out = sum(e["amountMinor"] for e in scenarios["baseline"]["events"] if e["id"] == business["ownerTransferId"])
    assert transfer_in + transfer_out == 0
    checks += 2

    shop = data["newPretzelShop"]
    result = shop["expected"]
    cash_after = shop["openingCashMinor"] - shop["ovenCashPriceMinor"] - shop["fitoutMinor"] - shop["premisesDepositMinor"]
    reserve = shop["monthlyFixedMinor"] * shop["reserveMonths"]
    contribution = shop["unitSellingPriceMinor"] - shop["unitVariableCostMinor"]
    assert cash_after == result["cashAfterCashPurchaseMinor"]
    assert reserve == result["cashPurchaseReserveMinor"]
    assert max(0, reserve - cash_after) == result["cashPurchaseReserveGapMinor"]
    assert math.ceil(shop["monthlyFixedMinor"] / contribution / shop["operatingDaysPerMonth"]) == result["cashPurchaseBreakEvenUnitsPerDay"]
    lease = shop["mockLease"]
    assert shop["openingCashMinor"] - lease["initialMinor"] - shop["fitoutMinor"] - shop["premisesDepositMinor"] == result["cashAfterLeaseInitialMinor"]
    lease_fixed = shop["monthlyFixedMinor"] + lease["monthlyMinor"]
    assert lease_fixed * shop["reserveMonths"] == result["leaseReserveMinor"]
    assert math.ceil(lease_fixed / contribution / shop["operatingDaysPerMonth"]) == result["leaseBreakEvenUnitsPerDay"]
    assert lease["initialMinor"] + lease["months"] * lease["monthlyMinor"] == result["nominalLeaseTotalMinor"]
    checks += 8
    print(f"PASS: {checks} arithmetic/fixture checks. No application or model behavior tested.")


if __name__ == "__main__":
    main()
