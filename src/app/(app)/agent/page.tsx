"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ErrorBox, Group, Row, Section, TaskStatus, useAction, Empty } from "@/ui/kit";
import { Icon } from "@/ui/icons";

const SUGGESTIONS: Record<string, string[]> = {
  "alex:PERSONAL": ["Can you stop the FitFlow trial before it charges me?", "Did anything try to charge me after a free trial?", "Am I paying for a gym I don't use?", "Is DashEats Plus still worth paying for?", "Is the student bundle worth it for me?", "Am I paying twice for cloud storage?", "Can I buy a 6,000 RON phone and still reach my home goal?", "What if I get a 10% raise?", "What if I invest what NextMove saves me?", "A 900 RON dental bill just came in. Am I still on track for the home?"],
  "laziz:BUSINESS": ["Can we take the 40,000 RON order?", "Which supplier should we buy the flour from?", "Who still owes us money?"],
  "laziz:PERSONAL": ["Will my bills clear before the owner transfer arrives?"],
};

export default function AgentPage() {
  const router = useRouter();
  const { epoch, session } = useSession();
  const tasks = useApi<any>("/tasks", { epoch, poll: (d: any) => (d?.tasks?.some((t: any) => ["QUEUED", "RUNNING"].includes(t.state)) ? 2000 : 15000) });
  const caps = useApi<any>("/capabilities", { epoch });
  const upcoming = useApi<any>("/upcoming", { epoch });
  const [text, setText] = useState("");
  const { run, busy, error } = useAction();
  const key = `${session?.customer}:${session?.context?.kind}`;
  const business = session?.context?.kind === "BUSINESS";

  const send = (value: string) =>
    run(async () => {
      const t = await api<any>("/tasks", { body: { text: value } });
      setText("");
      router.push(`/agent/tasks/${t.taskId}`);
    });

  const model = session?.model;
  const plannerLine =
    model?.planner === "simulated"
      ? "Planner: simulated and labelled (live model switched off for this run)"
      : model?.smoke?.ok || model?.last?.ok
        ? `Planner: live model ${model?.last?.model ?? model?.smoke?.model ?? model?.configuredModel}`
        : `Planner: live model ${model?.configuredModel ?? ""}; falls back to a labelled simulated planner if unavailable`;

  const groups = new Map<string, any[]>();
  for (const c of caps.data?.capabilities ?? []) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group)!.push(c);
  }

  return (
    <>
      <h1 className="title">Agent</h1>
      <p className="lede">Ask about your money. NextMove calculates, explains and prepares; nothing changes until you approve the exact details.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void send(text.trim());
        }}
      >
        <div className="composer">
          <label htmlFor="ask" className="sr-only">
            Ask NextMove
          </label>
          <textarea id="ask" rows={2} value={text} maxLength={600} onChange={(e) => setText(e.target.value)} placeholder={business ? "Ask about orders, suppliers or cash" : "Ask about a charge, a plan or a goal"} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (text.trim()) void send(text.trim()); } }} />
          <button type="submit" className="send-btn" disabled={busy || !text.trim()} aria-label="Send">
            <Icon.arrowUp />
          </button>
        </div>
      </form>
      <p className="caption" style={{ margin: "8px 0 0" }}>
        {plannerLine}
      </p>
      <div className="chips" style={{ marginTop: 12 }}>
        {(SUGGESTIONS[key] ?? []).map((s) => (
          <button key={s} type="button" className="chip" style={{ fontWeight: 500, textAlign: "left", height: "auto", paddingTop: 10, paddingBottom: 10, borderRadius: 16 }} onClick={() => send(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      <ErrorBox error={error} />

      <Section title="Tasks" id="tasks">
        <Group>
          {tasks.data?.tasks?.length ? (
            tasks.data.tasks.map((t: any) => <Row key={t.id} href={`/agent/tasks/${t.id}`} title={t.title} sub={<TaskStatus state={t.state} />} />)
          ) : (
            <Empty>Nothing needs your approval. Ask a question or start from a suggestion.</Empty>
          )}
        </Group>
      </Section>

      <Section title="Tools" id="tools">
        <Group>
          {!business ? <Row href="/agent/evidence" mark={<span className="mark" aria-hidden="true"><Icon.image size={20} /></span>} title="Add evidence" sub="Screen Time, a student card, an invoice or a screenshot" /> : null}
          {upcoming.data?.bulkCount ? <Row href="/batch" mark={<span className="mark" aria-hidden="true"><Icon.repeat size={20} /></span>} title={`Review all ${upcoming.data.bulkCount} recurring payments`} sub="Inspect each provider, then approve an exact list" /> : null}
          <Row href="/agent/monitoring" mark={<span className="mark" aria-hidden="true"><Icon.bell size={20} /></span>} title="Monitoring and alerts" sub="What NextMove watches, and your preferences" />
          {business ? <Row href="/business/packet" mark={<span className="mark" aria-hidden="true"><Icon.doc size={20} /></span>} title="Funding packet" sub="Prepared for the lender, not sent" /> : null}
        </Group>
      </Section>

      <Section title="What NextMove can help with" id="capabilities">
        <div className="stack">
          {[...groups.entries()].map(([group, list]) => (
            <div key={group}>
              <h3 className="label" style={{ margin: "0 0 8px" }}>
                {group}
              </h3>
              <Group>
                {list.map((c: any) =>
                  c.inThisContext ? (
                    <Row key={c.id} href={`/capabilities/${c.id}`} title={c.title} sub={c.short} />
                  ) : (
                    <Row key={c.id} title={c.title} sub={`${c.short}. Available in your ${c.contextKind === "BUSINESS" ? "business" : "personal"} context.`} chevron={false} />
                  ),
                )}
              </Group>
            </div>
          ))}
          <div>
            <h3 className="label" style={{ margin: "0 0 8px" }}>
              Planned
            </h3>
            <Group>
              <Row title="Operate apps on your own computer" sub="Planned, not in this build. The agent works only with simulated providers through an isolated browser or partner APIs." chevron={false} />
            </Group>
          </div>
        </div>
      </Section>
    </>
  );
}
