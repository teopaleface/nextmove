"use client";

import Link from "next/link";
import { use } from "react";
import { useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ErrorBox, Group, KV, Loading, Notice, PageHead, Row, Section } from "@/ui/kit";
import { date, money } from "@/ui/format";

const LABEL: Record<string, string> = {
  downPaymentMinor: "Down payment",
  transactionCostsMinor: "Purchase and moving costs",
  protectedReserveMinor: "Reserve to keep",
  monthlyContributionMinor: "Saved each month",
  liquidSource: "Counts towards it",
  destination: "Destination",
  country: "Country",
  start: "From",
  end: "To",
  budgetMinor: "Budget",
  dataNeedGb: "Mobile data needed (GB)",
  expectedCardSpendMinor: "Expected card spending",
  orderReceiptMinor: "Order value",
  openingCashMinor: "Cash available to open",
  ovenCashPriceMinor: "Oven, cash price",
  fitoutMinor: "Fit-out",
  premisesDepositMinor: "Premises deposit",
  monthlyFixedMinor: "Fixed costs per month",
  reserveMonths: "Reserve (months of fixed costs)",
  unitSellingPriceMinor: "Selling price per pretzel",
  unitVariableCostMinor: "Cost per pretzel",
  operatingDaysPerMonth: "Open days per month",
};

function fmt(key: string, v: unknown) {
  if (v == null || v === "") return "Not set";
  if (key.endsWith("Minor") && typeof v === "number") return money(v);
  if ((key === "start" || key === "end") && typeof v === "string") return date(v);
  return String(v);
}

export default function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { epoch } = useSession();
  const { data, error, reload } = useApi<any>(`/goals/${encodeURIComponent(decodeURIComponent(id))}`, { epoch });
  if (error && error.code === "WRONG_CONTEXT")
    return (
      <>
        <PageHead back="/goals" title="Different context" />
        <Notice tone="info">{error.message}. Use the context switcher at the top of the screen.</Notice>
      </>
    );
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the goal…" />;
  const g = data.goal;
  const inputs = g.inputs ?? {};
  const scalar = Object.entries(inputs).filter(([k, v]) => LABEL[k] && (v == null || typeof v !== "object"));
  const options: any[] = Array.isArray(inputs.options) ? inputs.options : Array.isArray(inputs.items) ? inputs.items : [];
  const assumptions: string[] = Array.isArray(inputs.assumptions) ? inputs.assumptions : [];
  return (
    <>
      <PageHead back="/goals" title={g.name} sub={`Plan revision ${g.revision}, updated ${date(g.updatedAt)}`} />
      {data.capabilityId ? (
        <Link href={`/capabilities/${data.capabilityId}`} className="btn primary main block" style={{ marginTop: 8 }}>
          Open the calculation
        </Link>
      ) : null}
      {scalar.length ? (
        <Section title="What the plan uses">
          <KV items={scalar.map(([k, v]) => ({ label: LABEL[k], value: fmt(k, v) }))} />
        </Section>
      ) : null}
      {options.length ? (
        <Section title={inputs.items ? "Saved items" : "Options"}>
          <Group>
            {options.map((o: any) => (
              <Row key={o.id ?? o.itemId ?? o.title} title={o.label ?? o.name ?? o.title} end={o.priceMinor != null ? money(o.priceMinor) : undefined} />
            ))}
          </Group>
        </Section>
      ) : null}
      {assumptions.length ? (
        <Section title="Assumptions">
          <div className="group pad">
            <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
              {assumptions.map((a) => (
                <li key={a} style={{ marginBottom: 6 }}>
                  {a}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}
      <Section title="Saved decisions">
        <Group>
          {data.saved.length ? (
            data.saved.map((x: any) => <Row key={x.id} title={x.choice ?? "Saved plan"} sub={`${x.result?.headline ?? ""}${x.result?.headline ? ". " : ""}Saved ${date(x.created_at)}, revision ${x.input_revision}`} />)
          ) : (
            <Row title="Nothing saved yet" sub={data.capabilityId === "O1" ? "Open the calculation, adjust it, then save the plan." : "Decisions you save appear here."} />
          )}
        </Group>
      </Section>
    </>
  );
}
