"use client";

import { useRouter } from "next/navigation";
import { use } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ErrorBox, Group, KV, Loading, PageHead, Row, Section, StateLine, useAction } from "@/ui/kit";
import { dayTime, money } from "@/ui/format";
import { recoveryKind, recoveryState } from "@/ui/labels";
import { ShieldTransactionState } from "@/ui/trial-shield";

export default function TransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { epoch } = useSession();
  const { data, error, reload } = useApi<any>(`/transactions/${encodeURIComponent(decodeURIComponent(id))}`, { epoch });
  const { run, busy, error: actError } = useAction();
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the transaction…" />;
  const t = data.transaction;
  const pending = t.status === "PENDING";
  const ask = () =>
    run(async () => {
      const r = await api<any>("/tasks", { body: { text: `Explain this charge: ${t.merchant_name} ${money(t.amount_minor)} on ${dayTime(t.booked_at)}. Is anything wrong with it?` } });
      router.push(`/agent/tasks/${r.taskId}`);
    });
  return (
    <>
      <PageHead back title={t.merchant_name} />
      <div className="group pad">
        <div className={`num${t.amount_minor > 0 ? " positive" : ""}`} style={{ color: pending || t.status === "RELEASED" ? "var(--muted)" : undefined, textDecoration: t.status === "RELEASED" ? "line-through" : undefined, fontSize: 32, lineHeight: "38px", fontWeight: 650 }}>
          {money(t.amount_minor, { sign: true })}
        </div>
        <div style={{ marginTop: 6 }}>
          {t.status === "RELEASED" || t.data?.trialShield ? <ShieldTransactionState t={t} /> : pending ? <StateLine tone="neutral">Pending card hold, not a second charge</StateLine> : t.amount_minor > 0 ? <StateLine tone="ok">Credit posted</StateLine> : <StateLine tone="ok">Posted</StateLine>}
        </div>
      </div>
      <Section title="Details">
        <KV
          items={[
            { label: "Date", value: dayTime(t.booked_at) },
            { label: "Category", value: t.category },
            ...(t.accountName ? [{ label: "Account", value: t.accountName }] : []),
            ...(t.card_last4 ? [{ label: "Card", value: `•••• ${t.card_last4}` }] : []),
            ...(t.reference ? [{ label: "Reference", value: t.reference }] : []),
            ...(t.order_ref ? [{ label: "Order", value: t.order_ref }] : []),
            ...(t.note ? [{ label: "Note", value: t.note }] : []),
          ]}
        />
      </Section>
      {data.ledgerLines?.length ? (
        <Section title="Bank ledger">
          <KV items={data.ledgerLines.map((l: any) => ({ label: l.name, value: money(l.amount_minor, { sign: true }) }))} />
          <p className="caption" style={{ margin: "8px 0 0" }}>
            Every posting balances to zero across accounts.
          </p>
        </Section>
      ) : null}
      {data.recovery ? (
        <Section title="Linked case">
          <Group>
            <Row href={`/activity/recoveries/${encodeURIComponent(data.recovery.id)}`} title={`${t.merchant_name} ${recoveryKind(data.recovery.kind)}`} sub={<StateLine tone={recoveryState(data.recovery.state).tone}>{recoveryState(data.recovery.state).text}</StateLine>} end={money(data.recovery.amount_minor)} />
          </Group>
        </Section>
      ) : null}
      {data.subscription ? (
        <Section title="Subscription">
          <Group>
            <Row href={`/home/subscriptions/${encodeURIComponent(data.subscription.id)}`} title={data.subscription.plan_name} sub="Plan, renewal and options" />
          </Group>
        </Section>
      ) : null}
      <Section title="Something wrong?">
        <Group>
          <Row href="/capabilities/A8" title="Possible duplicate charge" sub="Tells a card hold apart from two settled payments" />
          <Row href="/capabilities/A9" title="Price dropped after you bought it" sub="Checks the merchant's price-adjustment policy" />
          <Row href="/capabilities/A7" title="Track a refund" sub="Accepted, pending and credited stay separate" />
          <Row onClick={ask} title="Ask NextMove about this charge" sub={busy ? "Starting a task…" : "Starts an agent task with this transaction"} />
        </Group>
        <ErrorBox error={actError} />
      </Section>
    </>
  );
}
