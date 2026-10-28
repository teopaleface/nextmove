"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ActionStatus, ErrorBox, Group, KV, Loading, Notice, PageHead, Row, Section, useAction } from "@/ui/kit";
import { ROUTE_LABEL, dayTime, money, time } from "@/ui/format";
import { Icon } from "@/ui/icons";

const TERMINAL = new Set(["CONFIRMED", "REFUSED", "UNKNOWN", "BLOCKED", "TERMS_CHANGED", "REVOKED", "EXPIRED", "NOT_STARTED", "OUTDATED", "PREPARED", "NO_CHANGE", "PENDING"]);

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { epoch, session, switchContext } = useSession();
  const { data: p, error, reload, setData } = useApi<any>(`/proposals/${id}`, {
    epoch,
    poll: (d: any) => (d?.status === "APPROVED" && d.actions.some((a: any) => !TERMINAL.has(a.status)) ? 1200 : null),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const { run, busy, error: actError } = useAction();

  useEffect(() => {
    if (p && !selected) setSelected(new Set(p.actions.map((a: any) => a.id)));
  }, [p, selected]);

  useEffect(() => {
    if (p?.batchId) router.replace("/batch");
  }, [p?.batchId, router]);

  if (!p) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the proposal…" />;

  const single = p.actions.length === 1;
  const a0 = p.actions[0];
  const hasScheduledTransfers = p.actions.some((a: any) => a.operation === "INTERNAL_TRANSFER" && a.consequences?.effectiveAt);
  const otherContext = session?.context && p.context.id !== session.context.id;
  const chosen = selected ?? new Set<string>();
  // Money covers only the actions ticked for this approval.
  const total = (k: "immediateDebitMinor" | "maxDebitMinor" | "feesMinor" | "forecastChangeMinor") => p.actions.reduce((t: number, a: any) => t + (chosen.has(a.id) ? a.money[k] : 0), 0);
  const forecast = total("forecastChangeMinor");

  const approve = () =>
    run(async () => {
      const r = await api<any>(`/proposals/${p.id}/approve`, { body: { digest: p.digest, actionIds: [...chosen] } });
      setData(r.proposal);
      if (single) router.replace(`/actions/${a0.id}`);
      // Several actions stay on this screen: reload so progress polling starts from the approved state.
      else await reload();
    });
  const decline = () =>
    run(async () => {
      const r = await api<any>(`/proposals/${p.id}/decline`, { body: {} });
      setData(r.proposal);
    });
  const stop = () =>
    run(async () => {
      await api(`/mandates/${p.mandate.id}/stop`, { body: {} });
      await reload();
    });

  if (p.status !== "READY") {
    return (
      <>
        <PageHead back title={p.status === "APPROVED" ? (single ? a0.display.title : `${p.actions.length} approved actions`) : p.status === "DECLINED" ? "You kept the current plan" : "This plan needs a fresh check"} />
        {p.status === "OUTDATED" ? (
          <Notice tone="warn" title="Terms or inputs changed">
            {p.outdatedReason ?? "Something this plan relied on has changed."} The earlier approval no longer applies. Completed actions stay completed.
          </Notice>
        ) : null}
        {p.status === "EXPIRED" ? <Notice tone="warn">This review expired before it was approved. Prepare it again to see current terms.</Notice> : null}
        {p.status === "DECLINED" ? <Notice tone="info">Nothing was sent. Your charges and settings stay as they were. You can revisit this at any time.</Notice> : null}
        <Section title={p.status === "APPROVED" ? "Progress" : "Actions in this plan"}>
          <Group>
            {p.actions.map((a: any) => (
              <Row key={a.id} href={p.status === "APPROVED" ? `/actions/${a.id}` : undefined} title={a.display.title} sub={<ActionStatus status={a.status} merchant={a.merchantName} />} end={a.receipt ? a.receipt.reference : undefined} />
            ))}
          </Group>
        </Section>
        {p.status === "APPROVED" && p.mandate?.status === "ACTIVE" && p.actions.some((a: any) => a.status === "APPROVED") ? (
          <div className="actions">
            <button type="button" className="btn danger block" onClick={stop} disabled={busy}>
              <Icon.stop size={20} /> Stop actions that have not started
            </button>
            <p className="caption" style={{ margin: 0, textAlign: "center" }}>
              Requests already with a provider may still finish. Nothing is reversed.
            </p>
          </div>
        ) : null}
        {p.status !== "APPROVED" && a0?.capability && /^[OTA]\d+$/.test(a0.capability) ? (
          <div className="actions">
            <Link href={`/capabilities/${a0.capability}`} className="btn primary block">
              Review updated plan
            </Link>
          </div>
        ) : null}
        {p.taskId ? (
          <div className="actions">
            <Link className="btn block" href={`/agent/tasks/${p.taskId}`}>
              Open the task
            </Link>
          </div>
        ) : null}
        <ErrorBox error={actError} />
      </>
    );
  }

  return (
    <div className="sheet" role="dialog" aria-modal="false" aria-labelledby="review-title">
      <div className="sheet-grip" aria-hidden="true" />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="caption">Review and approve</span>
        <span className="header-spacer" />
        <button type="button" className="icon-btn" onClick={() => router.back()} aria-label="Close without approving">
          <Icon.x />
        </button>
      </div>
      <h1 className="heading" id="review-title" style={{ marginTop: 4 }}>
        {single ? a0.display.title : `${p.actions.length} actions to approve`}
      </h1>
      <p className="lede" style={{ marginTop: 6 }}>
        {single ? a0.display.summary : "Each action below runs only as described. You can leave any of them out."}
      </p>

      {otherContext ? (
        <div style={{ marginBottom: 12 }}>
          <Notice tone="warn" title={`This belongs to ${p.context.name}`}>
            Switch to {p.context.name} before approving.
            <div>
              <button type="button" className="btn text" style={{ paddingLeft: 0 }} onClick={() => switchContext(p.context.id).then(() => router.push(`/review/${p.id}`))}>
                Switch to {p.context.name}
              </button>
            </div>
          </Notice>
        </div>
      ) : null}

      <div className="stack">
        {p.actions.map((a: any) => (
          <ActionDetail key={a.id} a={a} single={single} checked={chosen.has(a.id)} onToggle={() => setSelected((s) => { const n = new Set(s ?? []); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} />
        ))}
      </div>

      {p.agentInputs?.length ? (
        <Section title="What the agent used">
          <KV items={p.agentInputs.map((i: any) => ({ label: i.label, value: i.value }))} />
          <p className="caption" style={{ margin: "8px 0 0" }}>
            The agent set these inputs from your request and answers. Everything else uses your saved plan and bank records.
          </p>
        </Section>
      ) : null}

      <Section title={single ? "Money" : `Money, ${chosen.size} selected`}>
        <KV
          items={[
            { label: "Pays now", value: money(total("immediateDebitMinor")) },
            { label: "Most it can cost", value: money(total("maxDebitMinor")) },
            { label: "Fees", value: money(total("feesMinor")) },
            { label: "Upcoming charges, next 30 days", value: forecast === 0 ? "No change" : forecast < 0 ? `${money(-forecast)} less` : `${money(forecast)} more` },
          ]}
        />
        <p className="caption" style={{ margin: "8px 0 0" }}>
          Charges avoided are future payments that will not be taken. They are not money added to your account.
        </p>
      </Section>

      <Section title="This approval">
        <KV
          items={[
            { label: "Context", value: p.context.name },
            { label: "Covers", value: `Exactly ${chosen.size} of ${p.actions.length} action${p.actions.length === 1 ? "" : "s"} as shown` },
            { label: hasScheduledTransfers ? "Immediate actions must start within" : "Must start within", value: `${p.approvalWindowMinutes} minutes of approval` },
            ...(hasScheduledTransfers ? [{ label: "Scheduled transfers", value: `Run on the listed dates; permission expires ${p.scheduledGrantGraceDays} days after each date (demo clock)` }] : []),
            { label: "Review valid until", value: `${time(p.readyExpiresAt)} (demo clock)` },
            { label: "If terms change", value: "Nothing is sent; you review again" },
          ]}
        />
        <p className="caption" style={{ margin: "8px 0 0" }}>
          Proposal {p.id.slice(0, 13)}, terms fingerprint {p.digest.slice(0, 12)}. Created {dayTime(p.createdAt)}.
        </p>
      </Section>

      <ErrorBox error={actError} />

      <div className="sheet-actions">
        <button type="button" className="btn primary main block" onClick={approve} disabled={busy || chosen.size === 0 || Boolean(otherContext)}>
          {busy ? "Approving…" : single ? (a0.display.confirmLabel && a0.display.confirmLabel !== "Approve" ? a0.display.confirmLabel : a0.display.title) : `Approve ${chosen.size} action${chosen.size === 1 ? "" : "s"}`}
        </button>
        <button type="button" className="btn text block" onClick={decline} disabled={busy}>
          {single ? a0.display.declineLabel ?? "Not now" : "Not now"}
        </button>
      </div>
    </div>
  );
}

function ActionDetail({ a, single, checked, onToggle }: { a: any; single: boolean; checked: boolean; onToggle: () => void }) {
  const c = a.consequences ?? {};
  const lines = [...(a.display.lines ?? [])];
  if (!lines.some((l: any) => l.label === "Route")) lines.push({ label: "Route", value: ROUTE_LABEL[a.route] ?? a.route });
  if (c.accessUntil && !lines.some((l: any) => /access/i.test(l.label))) lines.push({ label: "Access until", value: dayTime(c.accessUntil) });
  if (c.lostBenefits?.length) lines.push({ label: "You lose", value: c.lostBenefits.join("; ") });
  if (c.dataEffect) lines.push({ label: "Data", value: c.dataEffect });
  if (c.remainingObligations) lines.push({ label: "Still due", value: c.remainingObligations });
  return (
    <div data-voice-item="">
      {!single ? (
        <label className="check-row" style={{ padding: "4px 0 8px" }}>
          <input type="checkbox" checked={checked} onChange={onToggle} />
          <span>
            <span className="label" data-voice="" style={{ display: "block" }}>
              {a.display.title}
            </span>
            <span className="row-sub" style={{ display: "block" }}>
              {a.display.summary}
            </span>
            {a.dependsOn?.length ? (
              <span className="caption" style={{ display: "block" }}>
                Runs after: {a.dependsOn.join(", ")}
              </span>
            ) : null}
          </span>
        </label>
      ) : null}
      <KV items={lines.map((l: any) => ({ label: l.label, value: l.value }))} />
      {a.display.note ? (
        <p className="caption" style={{ margin: "8px 0 0" }}>
          {a.display.note}
        </p>
      ) : null}
    </div>
  );
}
