"use client";

import Link from "next/link";
import { use } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { BrowserFrame } from "@/ui/browser";
import { ActionStatus, ErrorBox, Group, KV, Loading, Notice, PageHead, Row, Section, Sources, actionState, useAction } from "@/ui/kit";
import { ROUTE_LABEL, dayTime, money, onDemoClock, time } from "@/ui/format";
import { Icon } from "@/ui/icons";

const LIVE = new Set(["APPROVED", "EXECUTING"]);

export default function ActionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { epoch, toast, demoOffset } = useSession();
  const real = (iso: string | null | undefined) => onDemoClock(iso, demoOffset);
  const { data, error, reload } = useApi<any>(`/actions/${id}`, { epoch, poll: (d: any) => (LIVE.has(d?.action?.status) ? 900 : ["UNKNOWN", "PENDING"].includes(d?.action?.status) ? 4000 : null) });
  const { run, busy, error: actError } = useAction();
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the action…" />;

  const a = data.action;
  // Bank-internal actions (payments, card changes) are confirmed by the bank, not by the payee.
  const by = a.route === "BANK_INTERNAL" ? "NextMove bank" : a.merchantName;
  const attempt = data.attempts[data.attempts.length - 1];
  const s = actionState(a.status, by);
  const browserSteps = attempt?.evidence?.steps ?? [];
  const live = LIVE.has(a.status);

  const check = () =>
    run(async () => {
      const r = await api<any>(`/actions/${a.id}/check`, { body: {} });
      toast(r.scheduled ? `Asked ${a.merchantName ?? "the provider"} for the current status. Nothing was resubmitted.` : "No open check for this action");
      setTimeout(reload, 1500);
    });
  const stop = () =>
    run(async () => {
      await api(`/mandates/${data.grant.mandate_id}/stop`, { body: {} });
      await reload();
    });

  return (
    <>
      <PageHead back title={a.display.title} sub={a.display.summary} />
      <div className="group pad" aria-live="polite">
        <div className="label">{headline(a.status, by)}</div>
        <div style={{ marginTop: 4 }}>
          <ActionStatus status={a.status} merchant={by} />
        </div>
        {a.status === "UNKNOWN" ? (
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            The request reached {a.merchantName} but its answer was lost. NextMove checks with {a.merchantName} instead of sending it again, so it cannot happen twice.
          </p>
        ) : null}
        {a.status === "PENDING" ? (
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            {a.merchantName} accepted the request for review. The charge stays in your forecast until they confirm.
          </p>
        ) : null}
        {a.status === "BLOCKED" ? (
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            {a.merchantName} asks the account holder to sign in on its own page. NextMove never signs in or solves checks for you; nothing was changed.
          </p>
        ) : null}
        {a.status === "TERMS_CHANGED" ? (
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            {a.merchantName}'s terms changed after you approved, so nothing was sent. Review the new terms before trying again.
          </p>
        ) : null}
        {a.result?.reason && ["REFUSED", "BLOCKED", "TERMS_CHANGED", "PENDING", "UNKNOWN", "REVOKED", "EXPIRED"].includes(a.status) ? <p className="caption" style={{ margin: "6px 0 0" }}>Provider said: {a.result.reason}</p> : null}
      </div>

      {a.route === "ISOLATED_BROWSER" ? (
        <Section title="What the agent saw" id="browser">
          <BrowserFrame steps={browserSteps.map((st: any) => ({ ...st, at: real(st.at) ?? st.at }))} merchant={a.merchantName ?? "Provider"} live={live} />
        </Section>
      ) : null}

      <Section title="Steps" id="steps">
        <Group>
          <ol className="timeline">
            <Step ok text="You approved the exact action" />
            {attempt ? <Step ok text={a.route === "BANK_INTERNAL" ? "Bank checked the approval and the account" : `Checked the current terms with ${a.merchantName}`} at={real(attempt.startedAt)} /> : <Step text="Waiting for a worker to start" />}
            {attempt?.dispatchedAt ? <Step ok text={a.route === "ISOLATED_BROWSER" ? "Final request passed the approval check and was sent from the page" : a.route === "BANK_INTERNAL" ? "Posted in the bank ledger" : "Request sent once, with a unique idempotency key"} at={real(attempt.dispatchedAt)} /> : null}
            {attempt?.finishedAt ? <Step ok={s.tone === "ok"} warn={s.tone !== "ok"} text={s.text} at={real(attempt.finishedAt)} /> : null}
            {attempt?.reconcileChecks ? <Step text={`Status checks with ${a.merchantName}: ${attempt.reconcileChecks}`} /> : null}
            {attempt?.nextCheckAt ? <Step text={`Next status check ${dayTime(attempt.nextCheckAt)} (demo clock)`} /> : null}
            {data.receipt ? <Step ok text={`Read back and verified: ${data.receipt.issuer_reference}`} at={data.receipt.verified_at} /> : null}
          </ol>
        </Group>
      </Section>

      {data.receipt ? (
        <Section>
          <Link className="btn primary block" href={`/receipts/${data.receipt.id}`}>
            View receipt {data.receipt.issuer_reference}
          </Link>
        </Section>
      ) : null}

      <div className="actions">
        {["UNKNOWN", "PENDING"].includes(a.status) ? (
          <button type="button" className="btn block" onClick={check} disabled={busy}>
            <Icon.refresh size={20} /> Check status now
          </button>
        ) : null}
        {a.status === "APPROVED" && data.grant?.status === "ACTIVE" ? (
          <button type="button" className="btn danger block" onClick={stop} disabled={busy}>
            <Icon.stop size={20} /> Stop before it starts
          </button>
        ) : null}
        {a.status === "TERMS_CHANGED" && a.display ? (
          <Link className="btn primary block" href={a.batchId ? "/batch" : /^[OTA]\d+$/.test(a.capability ?? "") ? `/capabilities/${a.capability}` : "/agent"}>
            Review the new terms
          </Link>
        ) : null}
        {a.taskId ? (
          <Link className="btn block" href={`/agent/tasks/${a.taskId}`}>
            Open the task
          </Link>
        ) : null}
        {a.batchId ? (
          <Link className="btn block" href="/batch">
            Back to the batch
          </Link>
        ) : null}
      </div>
      <ErrorBox error={actError} />

      <Section title="Approved details" id="details">
        <KV
          items={[
            { label: "Provider", value: a.merchantName ?? "NextMove" },
            { label: "Route", value: ROUTE_LABEL[a.route] ?? a.route },
            { label: "Terms approved", value: a.termsRevision ? `Revision ${a.termsRevision}` : "Bank terms" },
            { label: "Pays now", value: money(a.money?.immediateDebitMinor ?? 0) },
            { label: "Upcoming charges", value: a.money?.forecastChangeMinor ? (a.money.forecastChangeMinor < 0 ? `${money(-a.money.forecastChangeMinor)} less` : `${money(a.money.forecastChangeMinor)} more`) : "No change" },
            ...(data.grant ? [{ label: "Approval", value: grantText(data.grant) }] : []),
          ]}
        />
        <Sources codes={[a.route === "ISOLATED_BROWSER" ? "SIMULATED_MERCHANT_BROWSER" : a.route === "PARTNER_API" ? "SIMULATED_MERCHANT_API" : "BANK_LEDGER_POSTING", "CUSTOMER_APPROVAL"]} />
      </Section>

      <details className="dev">
        <summary>Developer view</summary>
        <pre>{JSON.stringify({ action: { id: a.id, status: a.status, route: a.route }, grant: data.grant, attempts: data.attempts.map((t: any) => ({ ...t, evidence: t.evidence ? { steps: t.evidence.steps?.length ?? 0, blockedRequests: t.evidence.blockedRequests, untrustedContentIgnored: t.evidence.untrustedContentIgnored } : null })) }, null, 2)}</pre>
      </details>
    </>
  );
}

function headline(status: string, merchant: string | null) {
  const m = merchant ?? "the provider";
  switch (status) {
    case "APPROVED":
      return "Approved. Starting now";
    case "EXECUTING":
      return `Agent is working with ${m}`;
    case "CONFIRMED":
      return `Done. ${m} confirmed it`;
    case "PENDING":
      return `Awaiting ${m} confirmation`;
    case "UNKNOWN":
      return "Confirmation hasn't arrived yet";
    case "REFUSED":
      return `${m} did not accept it`;
    case "BLOCKED":
      return `Your input is needed on ${m}'s page`;
    case "TERMS_CHANGED":
      return "Terms changed. Review before continuing";
    case "REVOKED":
      return "Stopped before it started";
    case "EXPIRED":
      return "The approval expired before it started";
    default:
      return status.replace(/_/g, " ").toLowerCase();
  }
}

function grantText(g: any) {
  if (g.status === "CONSUMED") return "Used once for this action";
  if (g.status === "ACTIVE") return `Valid until ${time(g.expires_at)} (demo clock)`;
  if (g.status === "REVOKED") return "Stopped by you";
  if (g.status === "EXPIRED") return "Expired unused";
  return g.status.toLowerCase();
}

function Step({ text, at, ok, warn }: { text: string; at?: string | null; ok?: boolean; warn?: boolean }) {
  return (
    <li>
      <span className={`t-icon${ok ? " ok" : warn ? " warn" : ""}`}>{ok ? <Icon.checkCircle size={18} /> : warn ? <Icon.warning size={18} /> : <Icon.clock size={18} />}</span>
      <span>
        <span className="t-text">{text}</span>
        {at ? <span className="caption" style={{ display: "block" }}>{time(at)}</span> : null}
      </span>
    </li>
  );
}
