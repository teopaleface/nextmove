"use client";

import Link from "next/link";
import { use } from "react";
import { useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ErrorBox, Group, KV, Loading, MerchantMark, Money, PageHead, Row, Section, StateLine } from "@/ui/kit";
import { date, day } from "@/ui/format";
import { PROVIDER_CAPABILITIES, forecastKind, subState } from "@/ui/labels";

const PERIOD: Record<string, string> = { MONTHLY: "month", ANNUAL: "year", YEARLY: "year", WEEKLY: "week" };

export default function SubscriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { epoch } = useSession();
  const { data, error, reload } = useApi<any>(`/subscriptions/${encodeURIComponent(decodeURIComponent(id))}`, { epoch });
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the subscription…" />;
  const s = data.subscription;
  const period = PERIOD[s.billing_period] ?? s.billing_period.toLowerCase();
  const caps = PROVIDER_CAPABILITIES[s.merchant_id] ?? [];
  const scheduled = data.forecast.filter((f: any) => f.status === "SCHEDULED");
  const removed = data.forecast.filter((f: any) => f.status !== "SCHEDULED");
  const off = s.state === "RENEWAL_OFF" || s.state === "CANCELLED";
  return (
    <>
      <PageHead back title={s.merchant_name} />
      <div className="group pad" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <MerchantMark name={s.merchant_name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="label">{s.plan_name}</div>
          <div className="small muted">
            <Money minor={s.amount_minor} /> a {period}
          </div>
        </div>
        <StateLine tone={off ? "neutral" : "ok"} icon={off ? "stop" : "check"}>
          {subState(s.state)}
        </StateLine>
      </div>
      <Section title="Details">
        <KV
          items={[
            ...(s.next_charge_at && !off ? [{ label: "Next charge", value: date(s.next_charge_at) }] : []),
            ...(s.access_until ? [{ label: "Access until", value: date(s.access_until) }] : []),
            { label: "Billing", value: `Every ${period}` },
            { label: "Terms", value: s.observed_revision === s.terms_revision ? `Revision ${s.terms_revision}` : `Revision ${s.observed_revision} seen, ${s.terms_revision} current` },
            ...(s.last_observed_at ? [{ label: "Last checked", value: date(s.last_observed_at) }] : []),
          ]}
        />
      </Section>
      {caps.length ? (
        <Section title="Options">
          <Group>
            {caps.map((c) => (
              <Row key={c.id} href={`/capabilities/${c.id}`} title={c.label} sub="Calculated from your own records" />
            ))}
          </Group>
        </Section>
      ) : null}
      <Section title="In your forecast">
        <Group>
          {scheduled.map((f: any) => (
            <Row key={f.id} title={forecastKind(f.kind)} sub={date(f.due_at)} end={<Money minor={f.amount_minor} sign />} />
          ))}
          {removed.map((f: any) => (
            <Row key={f.id} title={<s>{forecastKind(f.kind)}</s>} sub={`${date(f.due_at)}, ${f.status === "REMOVED" ? "removed after a confirmed change" : f.status.toLowerCase()}`} end={<span className="muted num">{<Money minor={f.amount_minor} sign />}</span>} />
          ))}
          {!data.forecast.length ? <Row title="No scheduled charges" /> : null}
        </Group>
      </Section>
      {data.charges.length ? (
        <Section title="Recent charges">
          <Group>
            {data.charges.map((t: any) => (
              <Row key={t.id} href={`/activity/transactions/${encodeURIComponent(t.id)}`} title={day(t.booked_at)} sub={t.status === "PENDING" ? "Pending card hold" : "Posted"} end={<Money minor={t.amount_minor} sign />} />
            ))}
          </Group>
        </Section>
      ) : null}
      {data.receipts.length ? (
        <Section title="Confirmed changes">
          <Group>
            {data.receipts.map((r: any) => (
              <Row key={r.id} href={`/receipts/${r.id}`} title={r.operation === "STOP_RENEWAL" ? "Renewal stopped" : r.operation.replace(/_/g, " ").toLowerCase()} sub={`Reference ${r.issuer_reference}`} endSub={day(r.verified_at)} />
            ))}
          </Group>
        </Section>
      ) : null}
      <div className="actions">
        <Link href="/home/upcoming" className="btn block">
          All upcoming payments
        </Link>
      </div>
    </>
  );
}
