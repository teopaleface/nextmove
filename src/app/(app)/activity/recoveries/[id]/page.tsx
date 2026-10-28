"use client";

import Link from "next/link";
import { use } from "react";
import { useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ActionStatus, ErrorBox, Group, KV, Loading, Notice, PageHead, Row, Section, StateLine } from "@/ui/kit";
import { date, dayTime, money } from "@/ui/format";
import { Icon } from "@/ui/icons";
import { recoveryKind, recoveryState } from "@/ui/labels";

const CAP: Record<string, string> = { REFUND: "A7", PRICE_ADJUSTMENT: "A9", DUPLICATE_CLAIM: "A8" };

export default function RecoveryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { epoch } = useSession();
  const { data, error, reload } = useApi<any>(`/recoveries/${encodeURIComponent(decodeURIComponent(id))}`, { epoch, poll: 8000 });
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the case…" />;
  const r = data.recovery;
  const s = recoveryState(r.state);
  const credited = Boolean(data.credit);
  const creditInTimeline = r.timeline.some((e: any) => e.state === "CREDITED");
  return (
    <>
      <PageHead back title={`${r.merchant_name} ${recoveryKind(r.kind)}`} />
      <div className="group pad">
        <div className="num" style={{ fontSize: 28, lineHeight: "34px", fontWeight: 650 }}>
          {money(r.amount_minor)}
        </div>
        <div style={{ marginTop: 6 }}>
          <StateLine tone={s.tone}>{s.text}</StateLine>
        </div>
      </div>
      {!credited ? (
        <div style={{ marginTop: 12 }}>
          <Notice tone="info">Your balance changes only when the bank credit arrives. A merchant accepting a refund is not money in your account.</Notice>
        </div>
      ) : null}
      <Section title="Timeline">
        <Group>
          <ol className="timeline">
            {r.timeline.map((e: any, i: number) => (
              <li key={i}>
                <span className="t-icon ok">
                  <Icon.checkCircle size={18} />
                </span>
                <span>
                  <span className="t-text">{e.label}</span>
                  <span className="caption" style={{ display: "block" }}>
                    {dayTime(e.at)}
                  </span>
                </span>
              </li>
            ))}
            {credited && creditInTimeline ? null : credited ? (
              <li>
                <span className="t-icon ok">
                  <Icon.checkCircle size={18} />
                </span>
                <span>
                  <span className="t-text">Credit posted to your account</span>
                  <span className="caption" style={{ display: "block" }}>
                    {dayTime(data.credit.booked_at)}
                  </span>
                </span>
              </li>
            ) : (
              <li>
                <span className="t-icon">
                  <Icon.clock size={18} />
                </span>
                <span>
                  <span className="t-text">Waiting for the bank credit</span>
                  <span className="caption" style={{ display: "block" }}>
                    {r.expected_by ? `Expected by ${date(r.expected_by)}` : "No date given by the merchant"}
                  </span>
                </span>
              </li>
            )}
          </ol>
        </Group>
      </Section>
      <Section title="Details">
        <KV
          items={[
            ...(r.reference ? [{ label: "Merchant reference", value: r.reference }] : []),
            ...(data.original ? [{ label: "Original payment", value: `${money(data.original.amount_minor)}, ${date(data.original.booked_at)}` }] : []),
            ...(credited ? [{ label: "Credit", value: `${money(data.credit.amount_minor, { sign: true })}, ${date(data.credit.booked_at)}` }] : []),
          ]}
        />
      </Section>
      {data.actions.length ? (
        <Section title="Actions on this case">
          <Group>
            {data.actions.map((a: any) => (
              <Row key={a.id} href={`/actions/${a.id}`} title={a.title ?? a.operation} sub={<ActionStatus status={a.status} merchant={r.merchant_name} />} />
            ))}
          </Group>
        </Section>
      ) : null}
      {data.credit ? (
        <div className="actions">
          <Link className="btn block" href={`/activity/transactions/${encodeURIComponent(data.credit.id)}`}>
            Open the credit
          </Link>
        </div>
      ) : null}
      {CAP[r.kind] ? (
        <div className="actions">
          <Link className="btn primary block" href={`/capabilities/${CAP[r.kind]}`}>
            {r.kind === "REFUND" ? "Follow up on this refund" : "Open the case in NextMove"}
          </Link>
        </div>
      ) : null}
    </>
  );
}
