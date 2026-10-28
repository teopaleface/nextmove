"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { Empty, ErrorBox, Group, KV, Loading, MerchantMark, Money, Notice, PageHead, Row, Section, StateLine, useAction } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { day, money } from "@/ui/format";

const REVIEW: Record<string, { text: string; sub: string }> = {
  READY: { text: "Ready to stop", sub: "Renewal can be turned off at period end, no fee" },
  ALREADY_OFF: { text: "Already off", sub: "The provider shows renewal already turned off" },
  NEEDS_AUTH: { text: "Sign-in needed", sub: "The provider asks you to sign in on its own site" },
  FIXED_COMMITMENT: { text: "Fixed commitment", sub: "Contract term or exit fee; not included" },
  PROTECTED_OR_SHARED: { text: "Protected or shared", sub: "Used by others or marked as protected; not included" },
  UNSUPPORTED: { text: "Not supported", sub: "No API or permitted web flow for this provider" },
};

const OUTCOME: Record<string, { text: string; tone: "ok" | "warn" | "bad" | "neutral"; icon?: "check" | "clock" | "warning" | "x" | "stop" | "doc" }> = {
  CONFIRMED: { text: "Confirmed by the provider", tone: "ok" },
  WAITING_EXTERNAL: { text: "Waiting for the provider's review", tone: "neutral", icon: "clock" },
  OUTCOME_UNKNOWN: { text: "Sent; confirmation not received yet", tone: "warn" },
  NEEDS_AUTH: { text: "Sign-in needed at the provider", tone: "warn" },
  TERMS_CHANGED: { text: "Terms changed; not sent", tone: "warn" },
  REFUSED: { text: "The provider refused", tone: "bad" },
  NOT_STARTED: { text: "Stopped before it started", tone: "neutral", icon: "stop" },
  IN_PROGRESS: { text: "Working", tone: "neutral", icon: "clock" },
  NOT_SELECTED: { text: "Not selected", tone: "neutral", icon: "stop" },
  FAILED: { text: "Could not finish", tone: "bad" },
};
const OUTCOME_ORDER = ["CONFIRMED", "WAITING_EXTERNAL", "NEEDS_AUTH", "TERMS_CHANGED", "OUTCOME_UNKNOWN", "REFUSED", "FAILED", "NOT_STARTED", "IN_PROGRESS"];
const ROUTE: Record<string, string> = { PARTNER_API: "Partner API", ISOLATED_BROWSER: "Provider website" };

export default function BatchPage() {
  const router = useRouter();
  const { epoch, session, toast } = useSession();
  const { data, error, reload } = useApi<any>("/batches/current", {
    epoch,
    poll: (d: any) => (d?.batch && ["INSPECTING", "RUNNING"].includes(d.batch.status) ? 1500 : d?.batch && (d.batch.outcomes?.OUTCOME_UNKNOWN || d.batch.outcomes?.WAITING_EXTERNAL || d.batch.outcomes?.IN_PROGRESS) ? 5000 : null),
  });
  const followups = useApi<any>(data?.batch?.id ? `/batches/${data.batch.id}/followups` : null, { epoch });
  const { run, busy, error: actError } = useAction();
  const [deselected, setDeselected] = useState<Set<string>>(new Set());

  const b = data?.batch ?? null;
  const ready = useMemo(() => (b?.items ?? []).filter((i: any) => i.reviewStatus === "READY" && i.actionId), [b]);
  const chosen = ready.filter((i: any) => !deselected.has(i.actionId));
  const chosenTotal = chosen.reduce((s: number, i: any) => s + (i.windowChargeMinor ?? 0), 0);

  const start = () =>
    run(async () => {
      await api("/batches", { body: {} });
      await reload();
    });
  const approve = () =>
    run(async () => {
      await api(`/batches/${b.id}/approve`, { body: { digest: b.proposalDigest, actionIds: chosen.map((i: any) => i.actionId) } });
      await reload();
    });
  const stop = () =>
    run(async () => {
      const r = await api<any>(`/batches/${b.id}/stop`, { body: {} });
      await reload();
      toast(`Stopped. ${r.revoked} not started; ${r.alreadyStarted} already sent may still finish.`);
    });
  const recheck = () =>
    run(async () => {
      const r = await api<any>(`/batches/${b.id}/recheck`, { body: {} });
      await reload();
      toast(r.scheduled ? `Asked ${r.scheduled} provider${r.scheduled === 1 ? "" : "s"} for the current status. Nothing was resubmitted.` : "Nothing to check right now");
    });
  const advance = (minutes: number) =>
    run(async () => {
      await api("/labs/clock", { body: { minutes } });
      await api(`/batches/${b.id}/recheck`, { body: {} });
      await reload();
      toast(`Labs: demo clock moved ${minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`}`);
    });
  const revise = (outcome: "TERMS_CHANGED" | "NEEDS_AUTH") =>
    run(async () => {
      const r = await api<any>(`/batches/${b.id}/revise`, { body: { outcome } });
      await followups.reload();
      if (r.proposal?.id) router.push(`/review/${r.proposal.id}`);
      else toast(r.notReady?.length ? `${r.notReady.length} still not ready: ${r.notReady[0]?.reason ?? "check the provider"}` : "Nothing new to approve");
    });
  const signIn = (merchantIds: string[]) =>
    run(async () => {
      await api("/labs/merchant", { body: { action: "restore_session", body: { merchantIds } } });
      toast("Labs: you signed in again at those providers");
    });

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the review…" />;

  if (!b)
    return (
      <>
        <PageHead back="/agent" title="Recurring payments" sub="NextMove checks every recurring payment with its provider, then you approve an exact list. Nothing changes before you approve." />
        {data.bulkCount ? (
          <>
            <div className="group pad" style={{ marginTop: 8 }}>
              <div className="num" style={{ fontSize: 36, lineHeight: "42px", fontWeight: 650 }}>
                {data.bulkCount}
              </div>
              <div className="small muted">recurring payments in this context</div>
            </div>
            <Section title="How it works">
              <Group>
                <Row title="1. Inspect" sub="Each provider is read for plan, renewal, fees and whether renewal can stop" chevron={false} />
                <Row title="2. Approve an exact list" sub="Only items that are safe to stop are offered; you can untick any" chevron={false} />
                <Row title="3. Watch and recover" sub="Live outcomes, Stop at any time, unknown results checked before any retry" chevron={false} />
              </Group>
            </Section>
            <div className="actions">
              <button type="button" className="btn primary main block" onClick={start} disabled={busy}>
                Start the review
              </button>
              <p className="caption" style={{ margin: 0, textAlign: "center" }}>
                Inspection only reads. No renewal is changed until you approve.
              </p>
            </div>
          </>
        ) : (
          <Group>
            <Empty>No recurring payments to review in this context</Empty>
          </Group>
        )}
        <ErrorBox error={actError} />
      </>
    );

  const counts = b.reviewCounts ?? {};
  const inspected = Object.entries(counts).filter(([k]) => k !== "PENDING").reduce((s, [, n]) => s + Number(n), 0);
  const outcomes: Record<string, number> = b.outcomes ?? {};
  const done = b.approvedCount - (outcomes.IN_PROGRESS ?? 0);
  const exceptions = (b.items as any[]).filter((i) => i.selected && i.outcome && !["CONFIRMED", "IN_PROGRESS", "NOT_SELECTED"].includes(i.outcome));
  const needsAuth = exceptions.filter((i) => i.outcome === "NEEDS_AUTH");
  const isLabs = session?.mode === "labs";
  const reviewing = b.status === "REVIEW" && b.proposalStatus === "READY";
  const running = b.status === "RUNNING";
  const started = b.approvedCount > 0;

  return (
    <>
      <PageHead back="/agent" title="Recurring payments" sub={`Window ${day(b.window.startInclusive)} to ${day(b.window.endExclusive)}. ${b.inventory} payments inspected one by one with each provider.`} />

      {b.status === "INSPECTING" ? (
        <div className="group pad" aria-live="polite" style={{ marginTop: 8 }}>
          <StateLine icon="clock">Inspecting with each provider</StateLine>
          <div className="num" style={{ fontSize: 28, lineHeight: "34px", fontWeight: 650, marginTop: 6 }}>
            {inspected} of {b.inventory}
          </div>
          <Progress value={inspected} max={b.inventory} label="Inspection progress" />
        </div>
      ) : null}

      {b.status !== "INSPECTING" ? (
        <Section title="What the inspection found" id="found">
          <Group>
            {Object.keys(REVIEW).map((k) =>
              counts[k] ? <Row key={k} title={REVIEW[k].text} sub={REVIEW[k].sub} end={<span className="num">{counts[k]}</span>} chevron={false} /> : null,
            )}
          </Group>
          <ExcludedList items={b.items} />
        </Section>
      ) : null}

      {reviewing ? (
        <Section title="Approve an exact list" id="approve">
          <div className="group pad">
            <div className="label">Stop renewal at the end of each paid period</div>
            <KV
              items={[
                { label: "Selected", value: `${chosen.length} of ${ready.length}` },
                { label: "Renewals inside the window", value: money(chosenTotal) },
                { label: "Fees", value: "None allowed (any fee stops that item)" },
                { label: "New subscriptions", value: "Never" },
                { label: "Time to start", value: "60 minutes after you approve" },
              ]}
            />
          </div>
          <details className="group" style={{ marginTop: 12 }}>
            <summary className="row" style={{ cursor: "pointer" }}>
              <span className="row-main">
                <span className="row-title">Choose items</span>
                <span className="row-sub">
                  {ROUTE.PARTNER_API} {ready.filter((i: any) => i.route === "PARTNER_API").length}, {ROUTE.ISOLATED_BROWSER.toLowerCase()} {ready.filter((i: any) => i.route === "ISOLATED_BROWSER").length}
                </span>
              </span>
            </summary>
            <div className="actions-inline" style={{ padding: "0 16px 8px" }}>
              <button type="button" className="btn small-btn" onClick={() => setDeselected(new Set())}>
                Select all
              </button>
              <button type="button" className="btn small-btn" onClick={() => setDeselected(new Set(ready.map((i: any) => i.actionId)))}>
                Clear
              </button>
            </div>
            {ready.map((i: any) => (
              <label key={i.id} className="row check-row">
                <input
                  type="checkbox"
                  checked={!deselected.has(i.actionId)}
                  onChange={() => {
                    const n = new Set(deselected);
                    if (n.has(i.actionId)) n.delete(i.actionId);
                    else n.add(i.actionId);
                    setDeselected(n);
                  }}
                />
                <MerchantMark name={i.merchantName} />
                <span className="row-main">
                  <span className="row-title">{i.merchantName}</span>
                  <span className="row-sub">
                    {ROUTE[i.route] ?? i.route}, next {day(i.nextChargeAt)}
                  </span>
                </span>
                <span className="row-end">
                  <span className="row-amount">
                    <Money minor={i.amountMinor} />
                  </span>
                </span>
              </label>
            ))}
          </details>
          <div className="actions">
            <button type="button" className="btn primary main block" onClick={approve} disabled={busy || chosen.length === 0}>
              Approve {chosen.length} exact {chosen.length === 1 ? "action" : "actions"}
            </button>
            <p className="caption" style={{ margin: 0, textAlign: "center" }}>
              Each provider must confirm before anything counts as done. You can stop at any time.
            </p>
          </div>
        </Section>
      ) : null}

      {started ? (
        <Section title={running ? "Working through your approval" : "Results"} id="results">
          {running ? (
            <div className="group pad" aria-live="polite">
              <div className="num" style={{ fontSize: 28, lineHeight: "34px", fontWeight: 650 }}>
                {done} of {b.approvedCount}
              </div>
              <div className="small muted">finished or waiting on a provider</div>
              <Progress value={done} max={b.approvedCount} label="Execution progress" />
              <div className="actions" style={{ marginTop: 12 }}>
                <button type="button" className="btn danger block" onClick={stop} disabled={busy}>
                  <Icon.stop size={18} /> Stop
                </button>
                <p className="caption" style={{ margin: 0, textAlign: "center" }}>
                  Stop blocks every request that has not started. Requests already sent may still finish and are checked.
                </p>
              </div>
            </div>
          ) : null}
          <Group>
            {OUTCOME_ORDER.map((k) =>
              outcomes[k] ? (
                <Row
                  key={k}
                  title={
                    <StateLine tone={OUTCOME[k].tone} icon={OUTCOME[k].icon}>
                      {OUTCOME[k].text}
                    </StateLine>
                  }
                  end={<span className="num">{outcomes[k]}</span>}
                  chevron={false}
                />
              ) : null,
            )}
          </Group>
          <div style={{ marginTop: 12 }}>
            <KV
              items={[
                { label: "Future charges avoided (confirmed)", value: money(b.avoidedFutureChargesMinor) },
                { label: "Funds before", value: money(b.fundsBeforeMinor) },
                { label: "Funds now", value: money(b.fundsNowMinor) },
                { label: "Cash refunded", value: money(b.cashRefundedMinor) },
              ]}
            />
            <p className="caption" style={{ margin: "8px 0 0" }}>
              Avoided charges are renewals inside the window that will not be taken, counted only from provider confirmations. Your balance does not change.
            </p>
          </div>
        </Section>
      ) : null}

      {started && exceptions.length ? (
        <Section title="Needs attention" id="exceptions">
          <div className="stack">
            {outcomes.OUTCOME_UNKNOWN || outcomes.WAITING_EXTERNAL ? (
              <div className="group pad">
                <div className="label">
                  {outcomes.OUTCOME_UNKNOWN ? `${outcomes.OUTCOME_UNKNOWN} sent without a confirmation` : null}
                  {outcomes.OUTCOME_UNKNOWN && outcomes.WAITING_EXTERNAL ? ", " : null}
                  {outcomes.WAITING_EXTERNAL ? `${outcomes.WAITING_EXTERNAL} waiting for provider review` : null}
                </div>
                <p className="small muted" style={{ margin: "4px 0 0" }}>
                  NextMove reads each provider again on a schedule. It never sends the same request twice while the result is unknown.
                </p>
                <div className="actions-inline" style={{ marginTop: 10 }}>
                  <button type="button" className="btn small-btn" onClick={recheck} disabled={busy}>
                    <Icon.refresh size={18} /> Check status now
                  </button>
                  {isLabs ? (
                    <>
                      <button type="button" className="btn small-btn" onClick={() => advance(6 * 60)} disabled={busy}>
                        Labs: +6 hours
                      </button>
                      <button type="button" className="btn small-btn" onClick={() => advance(48 * 60)} disabled={busy}>
                        Labs: +48 hours
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
            {outcomes.TERMS_CHANGED ? (
              <div className="group pad">
                <div className="label">{outcomes.TERMS_CHANGED} providers changed their terms</div>
                <p className="small muted" style={{ margin: "4px 0 0" }}>
                  Your approval covered the old terms, so these were not sent. Read the new terms and approve again if you still want them stopped.
                </p>
                <div className="actions-inline" style={{ marginTop: 10 }}>
                  <button type="button" className="btn primary small-btn" onClick={() => revise("TERMS_CHANGED")} disabled={busy}>
                    Review the new terms
                  </button>
                </div>
              </div>
            ) : null}
            {needsAuth.length ? (
              <div className="group pad">
                <div className="label">{needsAuth.length} providers need you to sign in</div>
                <p className="small muted" style={{ margin: "4px 0 0" }}>
                  The provider ended the session. NextMove never signs in, solves a CAPTCHA or enters a code for you. Sign in on the provider's own page, then prepare a fresh approval.
                </p>
                <div className="actions-inline" style={{ marginTop: 10 }}>
                  {isLabs ? (
                    <button type="button" className="btn small-btn" onClick={() => signIn([...new Set(needsAuth.map((i) => i.merchantId))])} disabled={busy}>
                      Labs: sign in at these providers
                    </button>
                  ) : null}
                  <button type="button" className="btn primary small-btn" onClick={() => revise("NEEDS_AUTH")} disabled={busy}>
                    Prepare a fresh approval
                  </button>
                </div>
              </div>
            ) : null}
            <details className="group">
              <summary className="row" style={{ cursor: "pointer" }}>
                <span className="row-main">
                  <span className="row-title">All {exceptions.length} items that need attention</span>
                </span>
              </summary>
              {exceptions.map((i) => (
                <Row
                  key={i.id}
                  href={i.actionId ? `/actions/${i.actionId}` : undefined}
                  mark={<MerchantMark name={i.merchantName} />}
                  title={i.merchantName}
                  sub={
                    <StateLine tone={OUTCOME[i.outcome]?.tone ?? "neutral"} icon={OUTCOME[i.outcome]?.icon}>
                      {OUTCOME[i.outcome]?.text ?? i.outcome}
                    </StateLine>
                  }
                  end={<Money minor={i.amountMinor} />}
                />
              ))}
            </details>
          </div>
        </Section>
      ) : null}

      {followups.data?.proposals?.length ? (
        <Section title="Follow-up approvals" id="followups">
          <Group>
            {followups.data.proposals.map((p: any) => (
              <Row
                key={p.id}
                href={`/review/${p.id}`}
                title={`${p.actions.length} ${p.actions.length === 1 ? "item" : "items"} with fresh terms`}
                sub={<StateLine tone={p.status === "APPROVED" ? "ok" : "neutral"} icon={p.status === "APPROVED" ? "check" : "doc"}>{p.status === "READY" ? "Waiting for your approval" : p.status === "APPROVED" ? "Approved" : p.status.toLowerCase()}</StateLine>}
              />
            ))}
          </Group>
        </Section>
      ) : null}

      {started ? (
        <details className="group" style={{ marginTop: 16 }}>
          <summary className="row" style={{ cursor: "pointer" }}>
            <span className="row-main">
              <span className="row-title">Confirmed items ({outcomes.CONFIRMED ?? 0})</span>
            </span>
          </summary>
          {(b.items as any[])
            .filter((i) => i.outcome === "CONFIRMED")
            .map((i) => (
              <Row key={i.id} href={i.actionId ? `/actions/${i.actionId}` : undefined} mark={<MerchantMark name={i.merchantName} />} title={i.merchantName} sub={`Reference ${i.receipt ?? "pending"}, ${ROUTE[i.route] ?? i.route}`} end={<Money minor={i.amountMinor} />} />
            ))}
        </details>
      ) : null}

      <div className="actions">
        <Link className="btn block" href={`/agent/tasks/${b.taskId}`}>
          See the activity log
        </Link>
        <a className="btn block" href={`/api/batches/${encodeURIComponent(b.id)}/export`} download>
          <Icon.download size={18} /> Export as CSV
        </a>
      </div>
      <ErrorBox error={actError} />
    </>
  );
}

function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function ExcludedList({ items }: { items: any[] }) {
  const excluded = items.filter((i) => i.reviewStatus !== "READY");
  if (!excluded.length) return null;
  return (
    <details className="group" style={{ marginTop: 12 }}>
      <summary className="row" style={{ cursor: "pointer" }}>
        <span className="row-main">
          <span className="row-title">{excluded.length} not included, and why</span>
        </span>
      </summary>
      {excluded.map((i) => (
        <Row key={i.id} mark={<MerchantMark name={i.merchantName} />} title={i.merchantName} sub={detailText(i)} end={<Money minor={i.amountMinor} />} chevron={false} />
      ))}
    </details>
  );
}

function detailText(i: any) {
  const d = i.reviewDetail ?? {};
  const base = REVIEW[i.reviewStatus]?.text ?? i.reviewStatus;
  if (i.reviewStatus === "ALREADY_OFF") return d.accessUntil ? `${base}, access until ${day(d.accessUntil)}` : base;
  if (d.reason) return `${base}: ${String(d.reason).slice(0, 120)}${d.exitFeeMinor ? ` (${money(d.exitFeeMinor)})` : ""}`;
  return base;
}
