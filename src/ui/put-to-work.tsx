"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/ui/api";
import { AgentSig } from "@/ui/icons";
import { ErrorBox, StateLine, useAction } from "@/ui/kit";
import { money, short } from "@/ui/format";

// The after-cancel offer on a stop receipt. Every amount, rate and projection comes from the server; choosing an
// option only asks the server to draft the exact transfer, which then needs the usual approval on /review.

export function PutToWork({ receiptId, offer, onChanged }: { receiptId: string; offer: any; onChanged: () => void }) {
  const router = useRouter();
  const [choice, setChoice] = useState<string | null>(offer.choice);
  const [reopened, setReopened] = useState(false);
  const { run, busy, error } = useAction();
  const amount = money(offer.amountMinor);
  const chosen = offer.options.find((o: any) => o.choice === offer.choice);

  if (offer.state === "DONE" || offer.state === "IN_PROGRESS") {
    return (
      <section className="section" aria-label="Put it to work" id="put-to-work">
        <div className="group pad">
          <StateLine tone={offer.state === "DONE" ? "ok" : "neutral"} icon={offer.state === "DONE" ? "check" : "clock"}>
            {offer.state === "DONE" ? `Moved ${amount} from ${offer.from.name} to ${chosen?.to}` : `Moving ${amount} from ${offer.from.name} to ${chosen?.to}`}
          </StateLine>
          <p className="caption" style={{ margin: "6px 0 0" }}>
            {chosen?.rateLabel}. One move per receipt.
          </p>
        </div>
        <div className="actions">
          {offer.transferReceipt ? (
            <Link className="btn block" href={`/receipts/${offer.transferReceipt.id}`}>
              View transfer receipt {offer.transferReceipt.reference}
            </Link>
          ) : offer.actionId ? (
            <Link className="btn block" href={`/actions/${offer.actionId}`}>
              See the transfer
            </Link>
          ) : null}
        </div>
      </section>
    );
  }

  if (offer.state === "DISMISSED" && !reopened) {
    return (
      <section className="section" aria-label="Put it to work" id="put-to-work">
        <p className="caption" style={{ margin: 0 }}>
          You chose not to move the {amount} for now. Nothing moved.{" "}
          <button type="button" className="btn text" style={{ minHeight: 0, padding: 0, fontSize: 12 }} onClick={() => setReopened(true)}>
            Show the options again
          </button>
        </p>
      </section>
    );
  }

  const review = () =>
    run(async () => {
      const p = await api<any>(`/receipts/${receiptId}/put-to-work`, { body: { choice } });
      router.push(`/review/${p.id}`);
    });
  const notNow = () =>
    run(async () => {
      await api(`/receipts/${receiptId}/put-to-work`, { body: { choice: "not-now" } });
      setReopened(false);
      onChanged();
    });

  return (
    <section className="section" aria-labelledby="put-to-work-title" id="put-to-work">
      <div className="opportunity">
        <AgentSig />
        <h2 id="put-to-work-title">You kept {short(offer.amountMinor)}. Put it to work?</h2>
        <p>
          {offer.merchant} will not take {amount}. That is a charge avoided, not a refund, so nothing was added to your account. If you like, NextMove can move {amount} from {offer.from.name} so it earns something.
        </p>
      </div>
      <div className="group" role="radiogroup" aria-label="Where the money goes" style={{ marginTop: 12 }}>
        {offer.options.map((o: any) => (
          <label key={o.choice} className="check-row">
            <input type="radio" name="put-to-work" value={o.choice} checked={choice === o.choice} onChange={() => setChoice(o.choice)} disabled={!offer.enoughInDaily} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="row-title" style={{ display: "block" }}>
                {o.title}
              </span>
              <span style={{ display: "block", margin: "4px 0" }}>
                <span className="tag">{o.badge}</span>
              </span>
              <span className="row-sub" style={{ display: "block" }}>
                {o.body}
              </span>
              <span className="caption" style={{ display: "block", marginTop: 4 }}>
                In {offer.projectionMonths} months: {money(o.totalMinor)}, of which {money(o.interestMinor)} interest at {o.rateLabel}. Projection, not a promise.
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="actions">
        {!offer.enoughInDaily ? (
          <StateLine tone="warn" icon="warning">
            {offer.from.name} holds {money(offer.from.balanceMinor)}, less than {amount}.
          </StateLine>
        ) : null}
        <button type="button" className="btn primary block main" onClick={review} disabled={busy || !choice || !offer.enoughInDaily}>
          {busy ? "Preparing…" : `Review: move ${amount} from ${offer.from.name}`}
        </button>
        <button type="button" className="btn text block" onClick={notNow} disabled={busy}>
          Not now
        </button>
        <p className="caption" style={{ margin: 0, textAlign: "center" }}>
          {offer.state === "PREPARED" ? "A draft is waiting for your approval. " : ""}Nothing moves until you approve the exact transfer on the next screen.
        </p>
      </div>
      <ErrorBox error={error} />
    </section>
  );
}
