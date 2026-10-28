"use client";

import Link from "next/link";
import { use, useState } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ActionStatus, ErrorBox, Group, Loading, Notice, PageHead, Row, Section, TaskStatus, useAction } from "@/ui/kit";
import { AgentSig, Icon } from "@/ui/icons";
import { evidenceLabel, money, onDemoClock, time } from "@/ui/format";
import { SimulationWidget } from "@/ui/simulation";

const ACTIVE = new Set(["QUEUED", "RUNNING"]);

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { epoch, demoOffset } = useSession();
  const { data, error, reload } = useApi<any>(`/tasks/${id}`, {
    epoch,
    poll: (d: any) => (ACTIVE.has(d?.task?.state) ? 1000 : d?.proposal && ["APPROVED"].includes(d.proposal.status) ? 2500 : null),
  });
  const { run, busy, error: actError } = useAction();
  const [free, setFree] = useState("");
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the task…" />;
  const t = data.task;
  const open = data.questions.filter((q: any) => q.status === "OPEN");
  const answer = data.blocks.find((b: any) => b.key === "answer")?.payload;
  const analyses = data.blocks.filter((b: any) => b.kind === "analysis").map((b: any) => b.payload);
  const batch = data.blocks.find((b: any) => b.key === "batch")?.payload;
  const simulations = data.blocks.filter((b: any) => b.kind === "simulation");
  const p = data.proposal;

  const reply = (questionId: string, value: string) =>
    run(async () => {
      await api(`/tasks/${t.id}/answer`, { body: { questionId, answer: value } });
      setFree("");
      await reload();
    });
  const stop = () =>
    run(async () => {
      await api(`/tasks/${t.id}/stop`, { body: {} });
      await reload();
    });

  return (
    <>
      <PageHead back="/agent" title={t.title} />
      <div className="group pad">
        <div className="caption">You asked</div>
        <div style={{ marginTop: 2 }}>{t.request}</div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 12px", marginTop: 10 }}>
          <TaskStatus state={t.state} />
          <span className="caption">{plannerText(t.plannerMode, t.model)}</span>
        </div>
      </div>

      {ACTIVE.has(t.state) || t.state === "WAITING_USER" || t.state === "NEEDS_APPROVAL" ? (
        <div className="actions-inline">
          <button type="button" className="btn small-btn" onClick={stop} disabled={busy}>
            <Icon.stop size={18} /> Stop task
          </button>
          <span className="caption" style={{ alignSelf: "center" }}>
            Stopping does not undo anything already confirmed.
          </span>
        </div>
      ) : null}
      {t.state === "STOPPED" && t.summary ? (
        <div style={{ marginTop: 12 }}>
          <Notice tone="info">{t.summary}</Notice>
        </div>
      ) : null}

      {open.map((q: any) => (
        <Section key={q.id} title="Needs your input">
          <div className="group pad">
            <div className="label">{q.text}</div>
            {q.options.length ? (
              <div className="chips" style={{ marginTop: 10 }}>
                {q.options.map((o: string) => (
                  <button key={o} type="button" className="chip" onClick={() => reply(q.id, o)} disabled={busy}>
                    {o}
                  </button>
                ))}
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (free.trim()) void reply(q.id, free.trim());
                }}
                style={{ display: "flex", gap: 8, marginTop: 10 }}
              >
                <label className="sr-only" htmlFor={`a-${q.id}`}>
                  Your answer
                </label>
                <input id={`a-${q.id}`} className="input" value={free} onChange={(e) => setFree(e.target.value)} maxLength={200} />
                <button type="submit" className="btn primary small-btn" disabled={busy || !free.trim()}>
                  Send
                </button>
              </form>
            )}
          </div>
        </Section>
      ))}

      {answer ? (
        <Section>
          <div className="opportunity">
            <AgentSig label={answer.by === "LIVE_MODEL" ? `Answer by ${t.model ?? "the live model"}` : "Answer by the simulated planner"} />
            <p style={{ margin: "10px 0 0", color: "var(--ink)", whiteSpace: "pre-line" }}>{answer.text}</p>
            <p className="caption" style={{ margin: "8px 0 0" }}>
              {answer.provenance}
            </p>
          </div>
          {simulations.length ? (
            <div className="stack" style={{ marginTop: 12 }}>
              {simulations.map((b: any) => (
                <SimulationWidget key={`${b.key}:${b.revision}`} sim={b.payload} />
              ))}
            </div>
          ) : null}
        </Section>
      ) : ACTIVE.has(t.state) ? (
        <Section>
          <div className="group pad" aria-live="polite">
            <div className="label">{data.events.length ? data.events[data.events.length - 1].label : "Starting"}</div>
            <div className="caption">Step {Math.max(1, t.stepCount)} of at most {t.stepBudget}</div>
          </div>
        </Section>
      ) : null}

      {analyses.length ? (
        <Section title="Calculations">
          <Group>
            {analyses.map((a: any) => (
              <CapabilityRow key={a.capability} id={a.capability} inputs={a.inputs} steps={data.steps} />
            ))}
          </Group>
        </Section>
      ) : null}

      {p ? (
        <Section title={p.status === "READY" ? "Ready to review" : "Proposed actions"}>
          <Group>
            {p.actions.map((a: any) => (
              <Row key={a.id} href={p.status === "APPROVED" ? `/actions/${a.id}` : undefined} title={a.display.title} sub={<ActionStatus status={a.status} merchant={a.merchantName} />} end={a.money.forecastChangeMinor < 0 ? `${money(-a.money.forecastChangeMinor)} less` : undefined} chevron={p.status === "APPROVED"} />
            ))}
          </Group>
          {p.status === "READY" ? (
            <div className="actions">
              <Link className="btn primary main block" href={`/review/${p.id}`}>
                Review and approve
              </Link>
              <p className="caption" style={{ margin: 0, textAlign: "center" }}>
                Nothing has been sent. You will see every term before anything happens.
              </p>
            </div>
          ) : p.status === "OUTDATED" ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="warn" title="This plan needs a fresh check">
                {p.outdatedReason ?? "Something it relied on changed."}
              </Notice>
            </div>
          ) : null}
        </Section>
      ) : null}

      {batch ? (
        <Section>
          <Link className="btn primary block" href="/batch">
            Open the batch review
          </Link>
        </Section>
      ) : null}

      <Section title="Activity" id="activity">
        <Group>
          <ol className="timeline" aria-live="polite">
            {data.events.map((e: any) => (
              <li key={e.seq}>
                <span className={`t-icon${/error|stop/.test(e.kind) ? " warn" : " ok"}`}>{/error/.test(e.kind) ? <Icon.warning size={18} /> : <Icon.checkCircle size={18} />}</span>
                <span>
                  <span className="t-text">{e.label}</span>
                  <span className="caption" style={{ display: "block" }}>
                    {time(onDemoClock(e.created_at, demoOffset))}
                    {e.evidence ? `, ${evidenceLabel(e.evidence)}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </Group>
      </Section>
      <ErrorBox error={actError} />

      <details className="dev">
        <summary>Developer view</summary>
        <pre>{JSON.stringify({ task: { id: t.id, state: t.state, plannerMode: t.plannerMode, model: t.model, steps: t.stepCount }, steps: data.steps }, null, 2)}</pre>
      </details>
    </>
  );
}

function plannerText(mode: string | null, model: string | null) {
  if (mode === "LIVE") return `Live model ${model ?? ""}`.trim();
  if (mode === "SIMULATED") return "Simulated planner (labelled)";
  if (mode === "SIMULATED_FALLBACK") return "Live model unavailable; simulated planner (labelled)";
  if (mode === "DETERMINISTIC") return "Deterministic review";
  return "Live model";
}

function CapabilityRow({ id, inputs, steps }: { id: string; inputs?: Record<string, unknown>; steps: any[] }) {
  const s = [...steps].reverse().find((x: any) => x.tool === "analyze" && x.capabilityId === id);
  // The calculation opens with the inputs this task used, so it shows the numbers the proposal was built on.
  const q = new URLSearchParams(Object.entries(inputs ?? {}).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).map(([k, v]) => [`i.${k}`, String(v)])).toString();
  return <Row href={`/capabilities/${id}${q ? `?${q}` : ""}`} title={s?.summary ?? id} sub="Open the full calculation" />;
}
