"use client";

import { useState } from "react";
import { api } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ErrorBox, Group, KV, PageHead, Row, Section, StateLine, useAction } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { dayTime } from "@/ui/format";

const FEATURE: Record<string, string> = {
  "execution.merchant": "Act with simulated providers",
  "execution.bank_internal": "Bank actions in the demo ledger",
  "preparation.local": "Prepare drafts and packets",
  monitoring: "Monitoring and alerts",
  vision: "Read images with the live model",
  "desktop.computer": "Operate apps on your computer (planned)",
};

export default function ProfilePage() {
  const { session, switchContext, signOut, refresh, toast } = useSession();
  const { run, busy, error } = useAction();
  const [dev, setDev] = useState<any>(null);
  if (!session?.authenticated) return null;
  const labs = session.mode === "labs";
  const model = session.model ?? {};
  const modelOk = model.smoke?.ok || model.last?.ok;

  const advance = (minutes: number) =>
    run(async () => {
      const r = await api<any>("/labs/clock", { body: { minutes } });
      await refresh();
      toast(`Labs: demo clock now ${dayTime(r.demoNow)}`);
    });
  const reset = () =>
    run(async () => {
      if (!window.confirm("Reset this demo copy to its starting data? Your approvals, receipts and uploads in this copy are removed.")) return;
      await api("/labs/reset", { body: {} });
      window.location.assign("/home");
    });
  const loadDev = () =>
    run(async () => {
      setDev(await api("/dev/status"));
    });

  return (
    <>
      <PageHead back title={session.user?.displayName ?? "Profile"} sub={session.isolated ? `Separate demo copy ${session.tenantRef}. Nothing here affects other sessions.` : "Shared demo data for this customer."} />

      <Section title="Contexts" id="contexts">
        <Group>
          {(session.contexts ?? []).map((c) => (
            <Row
              key={c.id}
              onClick={c.id === session.context?.id ? undefined : () => void switchContext(c.id)}
              mark={<span className="mark" aria-hidden="true">{c.kind === "BUSINESS" ? <Icon.briefcase size={20} /> : <Icon.user size={20} />}</span>}
              title={c.name}
              sub={c.id === session.context?.id ? <StateLine tone="ok">Current</StateLine> : `${c.subtitle}. Switch to it`}
              chevron={c.id !== session.context?.id}
            />
          ))}
        </Group>
      </Section>

      <Section title="This demo" id="demo">
        <KV
          items={[
            { label: "Mode", value: labs ? "Labs: simulated providers can be changed by you" : "Bank demo: actions are prepared, never executed" },
            { label: "Data", value: "Fictional people, providers and money" },
            { label: "Demo clock", value: dayTime(session.demoNow) },
            { label: "Planner", value: model.planner === "simulated" ? "Simulated planner (labelled)" : `Live model ${model.configuredModel ?? ""}`.trim() },
            { label: "Live model check", value: modelOk ? `Answered by ${model.last?.model ?? model.smoke?.model}` : model.smoke ? "Not answering; a labelled fallback is used" : "Not checked yet" },
            { label: "Model calls", value: `${model.totals?.ok ?? 0} answered of ${model.totals?.calls ?? 0}, ${model.totals?.images ?? 0} images read` },
          ]}
        />
      </Section>

      <Section title="What is switched on" id="features">
        <Group>
          {Object.entries(session.features?.features ?? {}).map(([k, on]) => (
            <Row key={k} title={FEATURE[k] ?? k} end={on ? <StateLine tone="ok">On</StateLine> : <StateLine icon="stop">Off</StateLine>} chevron={false} />
          ))}
        </Group>
        <p className="caption" style={{ margin: "8px 0 0" }}>
          Checked on the server for every approval and again by the worker before anything is sent. Real bank rails, merchants and payments do not exist in this build.
        </p>
      </Section>

      {labs ? (
        <Section title="Labs controls" id="labs">
          <Group>
            <Row onClick={busy ? undefined : () => advance(60)} mark={<span className="mark" aria-hidden="true"><Icon.clock size={20} /></span>} title="Move the demo clock 1 hour" sub="Scheduled checks and provider events catch up" />
            <Row onClick={busy ? undefined : () => advance(24 * 60)} mark={<span className="mark" aria-hidden="true"><Icon.calendar size={20} /></span>} title="Move the demo clock 1 day" sub="Trials, refunds and reviews move forward" />
            <Row onClick={busy ? undefined : reset} mark={<span className="mark" aria-hidden="true"><Icon.refresh size={20} /></span>} title="Reset this demo copy" sub="Back to the starting data" />
          </Group>
        </Section>
      ) : null}

      <Section title="Session" id="session">
        <Group>
          <Row onClick={() => void signOut()} mark={<span className="mark" aria-hidden="true"><Icon.user size={20} /></span>} title="Switch demo customer" sub="Signs out this session" />
        </Group>
      </Section>
      <ErrorBox error={error} />

      <details className="dev" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !dev) void loadDev(); }}>
        <summary>Developer view</summary>
        <pre>{dev ? JSON.stringify(dev, null, 2) : "Loading…"}</pre>
      </details>
    </>
  );
}
