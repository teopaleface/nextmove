# Financial Airbag (O9)

Financial Airbag opens an emergency review of Alex's optional outgoings at `/capabilities/O9`, also linked from Alex's personal Home. Opening the review, or asking vaguely to stop spending, creates no proposal or approval. Every service starts at **Keep unchanged**. The screen uses the existing Analysis, InputField and Candidate components.

The review reads this tenant and context's subscriptions, provider directory, live provider contracts, dated forecast and account balances. The separate 200-payment bulk Labs dataset is excluded. Costs cover the next 30 days from the tenant's current clock, with explicit start and end times and an exclusive end. Cash is shown separately and is unchanged. The conditional comparison includes only available choices; pending or unknown changes still count as due until the existing worker verifies a receipt. It estimates no unrecorded charges, interest, runway or lifetime savings.

Choose a service action, Recalculate, then review the selected actions together. Each service has at most one action:

- **Provider pause for one month:** offered only for an API that supports PAUSE, a matching next monthly charge and verified zero fees. Access stops at the pause start and resumes automatically on the displayed date and current contract price. The projection moves only the first forecast item, matching the existing worker.
- **Turn off renewal:** offered only when the connector supports STOP_RENEWAL and the contract has no current minimum commitment or unconfirmed/nonzero exit fee. Paid access continues until the displayed access end, then stops. Existing obligations stay due.

These operations differ from **blocking a card**, which does not end a provider contract. O9 offers no card freeze, merchant block, loan or overdraft action. Unsupported services remain visible with reasons and stay unchanged.

Rent, utilities, loans, insurance, healthcare, mobile data, storage and student tools remain protected. Known storage and required-benefit dependencies from either bank or provider records cannot be bypassed. Shared or household-owned plans require a separate owner review. TV and offline playback are protected by default; the customer must turn that protection off and explicitly select the service action before any loss can enter a proposal. Losses, dates, fees, provider/account identity, terms revision and automatic restart obligations remain in the exact approval.

O9 uses the existing immutable proposal manifest, digest approval, grants, dispatch gate, merchant idempotency, worker outcomes and per-item receipts. It adds no schema or operation type. Approved, executing, pending and unknown changes block another O9 submission for the same subject or canonical contract. Reopening a review never reconciles by resubmitting. A confirmed renewal-off is not offered again; a provider's pending change or scheduled pause is held for review. The existing bank-demo execution switch still applies.

The input contract stays primitive: one playback toggle and up to 19 service selects, each keyed to its tenant-local subscription. No client-authored action spec, amount or array is accepted. A comparison assumes every available choice confirms; the final review shows the exact selected subset, and each item may succeed, wait, fail or require reconciliation separately.

## Demo

1. In Labs, sign in as Alex and open Home → Financial Airbag. Confirm there are no selected cuts and current cash is separate from scheduled costs.
2. To include Streamly, turn off **Keep TV and offline playback** and Recalculate. Choose Streamly's **Provider pause · 1 month** and DashEats Plus's **Turn off renewal**, then Recalculate again.
3. Review the two actions. Streamly's approval includes lost TV/offline access and the automatic restart date/price. DashEats has paid access until its end date and no restart. Approve the exact manifest.
4. Open each action outcome and receipt. After confirmation, reopen O9: the dated costs reflect the confirmed outcomes, current cash is unchanged, and the same changes cannot be sent again while in progress or already applied.

Focused tests are in `tests/unit/financial-airbag.test.ts` and `tests/integration/financial-airbag.test.ts`. They cover protections, explicit choices, dated projections, a real two-item API execution, receipts, replay, a provider-pending outcome, the UNKNOWN read guard, unsupported operations and tenant/context isolation. The UNKNOWN guard uses a test fixture; transport loss/reconciliation remains covered by the existing recovery suite. The implementation patch itself is authored without applying or running these tests; the parent validates it in the integration worktree. Recordings, evidence-manifest generation, live-model E2E and rendered UI/device acceptance remain postponed.
