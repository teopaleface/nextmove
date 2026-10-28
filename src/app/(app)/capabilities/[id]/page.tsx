"use client";

import Link from "next/link";
import { use, useState } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { AnalysisView, CandidatePicker, InputsForm } from "@/ui/analysis";
import { ErrorBox, Group, Loading, Notice, PageHead, Row, Section, useAction } from "@/ui/kit";
import { AgentSig, Icon } from "@/ui/icons";
import { ShieldDecision } from "@/ui/trial-shield";

export default function CapabilityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const cap = id.toUpperCase();
  const { epoch, session, toast } = useSession();
  const { data, error, reload, setData } = useApi<any>(`/capabilities/${cap}`, { epoch });
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const recalc = useAction();
  const act = useAction();

  const apply = (values: Record<string, unknown>) =>
    recalc.run(async () => {
      const a = await api(`/capabilities/${cap}`, { body: { inputs: values } });
      setInputs(values);
      setData(a);
    });

  const refresh = async () => {
    const a = await api(`/capabilities/${cap}`, { body: { inputs } });
    setData(a);
  };

  // Most questions record a fact; a few answers are standing preferences that every later calculation uses.
  const answer = (key: string, value: string) =>
    act.run(async () => {
      if (key === "hotspot_required") await api("/preferences", { body: { key, value: value === "true" } });
      else await api("/facts", { body: { key, value } });
      await refresh();
    });

  const labs = (l: { action: string; label: string; body?: Record<string, unknown>; endpoint?: string }) =>
    act.run(async () => {
      if (l.endpoint === "bank") await api("/labs/bank", { body: { action: l.action, body: l.body ?? {} } });
      else if (l.endpoint) await api(l.endpoint, { body: l.body ?? {} });
      else await api("/labs/merchant", { body: { action: l.action, body: l.body ?? {} } });
      await refresh();
      toast(`Labs: ${l.label}`);
    });

  const save = () =>
    act.run(async () => {
      const r = await api<any>("/capabilities/O1/save", { body: { inputs, choice: data?.headline?.slice(0, 80) } });
      toast(`Saved as plan revision ${r.revision}`);
    });

  const verify = () =>
    act.run(async () => {
      const r = await api<any>("/capabilities/A14/verify", { body: {} });
      await refresh();
      toast(r.verified ? "Card travel credit confirmed from the bank record" : "The card benefit could not be confirmed");
    });

  if (error && error.code === "WRONG_CONTEXT")
    return (
      <>
        <PageHead back title="Different context" />
        <Notice tone="info">{error.message}. Use the context switcher at the top of the screen.</Notice>
      </>
    );
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Calculating…" />;

  return (
    <>
      <PageHead back title={data.title} sub={data.summary} />
      <div className="opportunity" style={{ marginTop: 4 }}>
        <AgentSig label="NextMove calculation" />
        <h2 style={{ fontSize: 20, lineHeight: "26px" }}>{data.headline}</h2>
      </div>

      {cap === "T4" ? <ShieldDecision key={data.candidates?.map((c: any) => c.key).join("|")} candidates={data.candidates ?? []} /> : null}

      <Section>
        <AnalysisView a={data} onAnswer={answer} />
      </Section>

      {data.inputs?.length ? (
        <Section title="Assumptions you can change" id="assumptions">
          <InputsForm key={JSON.stringify(data.inputs.map((f: any) => [f.key, f.value]))} fields={data.inputs} onApply={apply} busy={recalc.busy} />
          <ErrorBox error={recalc.error} />
          {cap === "O1" ? (
            <div className="actions">
              <button type="button" className="btn block" onClick={save} disabled={act.busy}>
                Save this plan to my goal
              </button>
            </div>
          ) : null}
        </Section>
      ) : null}

      {cap === "A14" ? (
        <Section title="Card benefit" id="benefit">
          <div className="actions" style={{ marginTop: 0 }}>
            <button type="button" className="btn block" onClick={verify} disabled={act.busy}>
              Check my card's travel credit
            </button>
          </div>
        </Section>
      ) : null}

      {data.candidates?.length && cap !== "T4" ? (
        <Section title="What NextMove can do" id="actions">
          {session?.mode === "bank-demo" ? (
            <div style={{ marginBottom: 12 }}>
              <Notice tone="info">This bank demo prepares and explains actions; it does not execute them.</Notice>
            </div>
          ) : null}
          <CandidatePicker key={data.candidates.map((c: any) => `${c.key}:${c.available}`).join("|")} capabilityId={cap} candidates={data.candidates} inputs={inputs} />
        </Section>
      ) : null}

      {data.done ? (
        <Section>
          <Notice tone="info" title="Done">
            {data.done.href ? <Link href={data.done.href}>{data.done.label}</Link> : data.done.label}
          </Notice>
        </Section>
      ) : null}

      {data.links?.length ? (
        <Section title="Related" id="related">
          <Group>
            {data.links.map((l: any) => (
              <Row key={l.href + l.label} href={l.href} title={l.label} />
            ))}
          </Group>
        </Section>
      ) : null}

      {data.labs?.length && session?.mode === "labs" ? (
        <Section title="Labs controls" id="labs">
          <p className="caption" style={{ margin: "0 0 8px" }}>
            These simulate what the fictional provider does next, so you can see how NextMove reacts. They are not customer actions.
          </p>
          <Group>
            {data.labs.map((l: any) => (
              <Row key={l.action + l.label} onClick={() => labs(l)} mark={<span className="mark" aria-hidden="true"><Icon.globe size={20} /></span>} title={l.label} sub="Labs simulation" />
            ))}
          </Group>
        </Section>
      ) : null}
      <ErrorBox error={act.error} />

      <details className="dev">
        <summary>Developer view</summary>
        <pre>{JSON.stringify({ capability: data.capability, numbers: data.numbers, evidence: data.evidence, candidates: data.candidates?.map((c: any) => ({ key: c.key, operation: c.spec.operation, route: c.spec.route, available: c.available })) }, null, 2)}</pre>
      </details>
    </>
  );
}
