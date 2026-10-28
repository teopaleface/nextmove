"use client";

import Link from "next/link";
import { use } from "react";
import { useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ErrorBox, Group, KV, Loading, PageHead, Section, Sources } from "@/ui/kit";
import { dayTime, money } from "@/ui/format";
import { Icon } from "@/ui/icons";

export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { epoch } = useSession();
  const { data, error, reload } = useApi<any>(`/receipts/${id}`, { epoch });
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the receipt…" />;
  const r = data.receipt;
  const a = data.action ?? {};
  const merchant = a.merchantName ?? r.issuer;
  const forecast = r.money?.forecastChangeMinor ?? a.money?.forecastChangeMinor ?? 0;
  const debit = a.money?.immediateDebitMinor ?? 0;
  const checks: string[] = r.verification?.checks ?? [];
  return (
    <>
      <PageHead back title="Receipt" />
      <div className="group pad" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <span style={{ color: "var(--success)", paddingTop: 2 }}>
          <Icon.checkCircle size={28} />
        </span>
        <div>
          <div className="section-title">{a.display?.title ?? r.operation}</div>
          <div className="small muted">
            Confirmed by {merchant}, reference <span className="num">{r.issuer_reference}</span>
          </div>
        </div>
      </div>

      <Section title="What changed">
        <KV
          items={[
            { label: "Reference", value: r.issuer_reference },
            { label: "Effective", value: dayTime(r.effective_at) },
            ...(r.access_until ? [{ label: "Access until", value: dayTime(r.access_until) }] : []),
            ...(r.terms_revision ? [{ label: "Terms", value: `Revision ${r.terms_revision}` }] : []),
            { label: "Future charges", value: forecast < 0 ? `${money(-forecast)} avoided` : forecast > 0 ? `${money(forecast)} added` : "No change" },
            { label: "Your balance", value: debit ? `${money(-debit)} posted` : "Unchanged by this action" },
            { label: "Verified", value: dayTime(r.verified_at) },
          ]}
        />
        {forecast < 0 && !debit ? (
          <p className="caption" style={{ margin: "8px 0 0" }}>
            An avoided charge is a future payment that will not be taken. It is not a refund and does not add money to your account.
          </p>
        ) : null}
      </Section>

      <Section title="How NextMove checked it">
        <Group>
          <div className="row">
            <div className="row-main">
              <div className="row-title">{r.verification?.method ?? "Provider confirmation read back"}</div>
              <div className="row-sub">Channel: {r.verification?.channel === "WEB" ? "provider website (isolated browser)" : r.verification?.channel === "API" ? "partner API" : r.verification?.channel === "BANK" ? "NextMove bank" : r.verification?.channel ?? "provider"}</div>
            </div>
          </div>
          {checks.map((c) => (
            <div key={c} className="row">
              <span style={{ color: "var(--success)" }}>
                <Icon.check size={18} />
              </span>
              <div className="row-main small">{c}</div>
            </div>
          ))}
        </Group>
        <Sources codes={[r.verification?.evidence]} prefix="Evidence" />
      </Section>

      <div className="actions">
        {r.action_id ? (
          <Link className="btn block" href={`/actions/${r.action_id}`}>
            See the steps
          </Link>
        ) : null}
        <Link className="btn block" href="/home/upcoming">
          View updated payments
        </Link>
      </div>

      <details className="dev">
        <summary>Developer view</summary>
        <pre>{JSON.stringify({ receipt: { ...r, verification: r.verification }, operation: a.operation, route: a.route }, null, 2)}</pre>
      </details>
    </>
  );
}
