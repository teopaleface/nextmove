"use client";

import { useState } from "react";
import { useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { Empty, ErrorBox, Group, Loading, MerchantMark, Money, Row, StateLine, TaskStatus } from "@/ui/kit";
import { date, dayTime, money } from "@/ui/format";
import { recoveryKind, recoveryState, subState } from "@/ui/labels";

const FILTERS = [
  { id: "posted", label: "Transactions" },
  { id: "agent", label: "Agent outcomes" },
  { id: "refunds", label: "Refunds" },
  { id: "plans", label: "Subscriptions" },
] as const;

export default function ActivityPage() {
  const { epoch } = useSession();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("posted");
  const { data, error, reload } = useApi<any>("/activity", { epoch, poll: 10_000 });
  return (
    <>
      <h1 className="title">Activity</h1>
      <div className="seg" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {!data ? (
        error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />
      ) : (
        <div style={{ marginTop: 16 }}>
          {filter === "posted" ? <Transactions txns={data.transactions} /> : null}
          {filter === "agent" ? (
            <div className="stack">
              <Group>
                {data.receipts.length ? (
                  data.receipts.map((r: any) => <Row key={r.id} href={`/receipts/${r.id}`} mark={<MerchantMark name={r.merchantName} />} title={r.title} sub={<StateLine tone="ok">Confirmed by {r.merchantName}, {r.issuer_reference}</StateLine>} endSub={date(r.verified_at)} />)
                ) : (
                  <Empty>No confirmed agent actions yet</Empty>
                )}
              </Group>
              <Group>
                {data.tasks.length ? data.tasks.map((t: any) => <Row key={t.id} href={`/agent/tasks/${t.id}`} title={t.title} sub={<TaskStatus state={t.state} />} />) : <Empty>No agent tasks yet</Empty>}
              </Group>
            </div>
          ) : null}
          {filter === "refunds" ? (
            <Group>
              {data.recoveries.length ? (
                data.recoveries.map((r: any) => {
                  const s = recoveryState(r.state);
                  return <Row key={r.id} href={`/activity/recoveries/${encodeURIComponent(r.id)}`} mark={<MerchantMark name={r.merchant_name} />} title={`${r.merchant_name} ${recoveryKind(r.kind)}`} sub={<StateLine tone={s.tone}>{s.text}</StateLine>} end={<Money minor={r.amount_minor} />} />;
                })
              ) : (
                <Empty>No refunds or claims</Empty>
              )}
            </Group>
          ) : null}
          {filter === "plans" ? (
            <Group>
              {data.subscriptions.length ? (
                data.subscriptions.map((s: any) => <Row key={s.id} href={`/home/subscriptions/${encodeURIComponent(s.id)}`} mark={<MerchantMark name={s.merchant_name} />} title={s.merchant_name} sub={`${s.plan_name}, ${subState(s.state)}`} end={<Money minor={s.amount_minor} />} endSub={s.next_charge_at ? `Next ${date(s.next_charge_at)}` : undefined} />)
              ) : (
                <Empty>No subscriptions in this context</Empty>
              )}
            </Group>
          ) : null}
        </div>
      )}
    </>
  );
}

function Transactions({ txns }: { txns: any[] }) {
  if (!txns.length) return <Empty>No transactions in this period</Empty>;
  const byDay = new Map<string, any[]>();
  for (const t of txns) {
    const k = date(t.booked_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(t);
  }
  return (
    <div className="stack">
      {[...byDay.entries()].map(([d, list]) => (
        <div key={d}>
          <h2 className="caption" style={{ margin: "0 0 6px", fontSize: 13 }}>
            {d}
          </h2>
          <Group>
            {list.map((t) => (
              <Row
                key={t.id}
                href={`/activity/transactions/${encodeURIComponent(t.id)}`}
                mark={<MerchantMark name={t.merchant_name} />}
                title={t.merchant_name}
                sub={t.status === "PENDING" ? `${t.category}, ${t.note?.startsWith("Held by Trial Shield") ? "held by Trial Shield" : "pending card hold"}` : t.status === "RELEASED" ? `${t.category}, ${t.reference?.startsWith("CHK-") ? "card check, released" : "released, not charged"}` : t.amount_minor > 0 ? `${t.category}, credit` : t.category}
                end={<span className={`num${t.amount_minor > 0 ? " positive" : ""}`} style={t.status === "PENDING" ? { color: "var(--muted)" } : t.status === "RELEASED" ? { color: "var(--muted)", textDecoration: "line-through" } : undefined}>{money(t.amount_minor, { sign: true })}</span>}
                endSub={dayTime(t.booked_at).split(", ")[1]}
              />
            ))}
          </Group>
        </div>
      ))}
    </div>
  );
}
