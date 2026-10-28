"use client";

import { useState } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { Empty, ErrorBox, Group, Loading, PageHead, Row, Section, StateLine, useAction } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { date, dayTime, onDemoClock } from "@/ui/format";

const CAP_LINK = /^[OTA]\d{1,2}$/;

export default function MonitoringPage() {
  const { epoch, session, toast, demoOffset } = useSession();
  const { data, error, reload } = useApi<any>("/permissions", { epoch, poll: 20_000 });
  const { run, busy, error: actError } = useAction();
  // Preference controls answer the tap at once; the saved value replaces this when the server confirms it.
  const [pending, setPending] = useState<Record<string, unknown>>({});
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading monitoring…" />;
  const business = session?.context?.kind === "BUSINESS";
  const prefs = { ...(data.preferences ?? {}), ...pending };
  const protectedB: string[] = Array.isArray(prefs.protected_benefits) ? prefs.protected_benefits : ["offline_playback"];
  const hotspot: boolean | null = typeof prefs.hotspot_required === "boolean" ? prefs.hotspot_required : null;
  const unread = data.notifications.filter((n: any) => !n.read_at).length;
  const notified = new Set(data.notifications.map((n: any) => n.finding_id).filter(Boolean));
  const findings = data.findings.filter((f: any) => !notified.has(f.id));

  const revoke = (p: any) =>
    run(async () => {
      const r = await api<any>(`/permissions/${encodeURIComponent(p.id)}/revoke`, { body: {} });
      await reload();
      toast(p.kind === "MONITOR" ? `Monitoring of ${p.source} stopped${r.watchesStopped ? `, ${r.watchesStopped} check${r.watchesStopped === 1 ? "" : "s"} ended` : ""}` : `Access to ${p.source} revoked`);
    });
  const setPref = (key: string, value: unknown) => {
    setPending((p) => ({ ...p, [key]: value }));
    return run(async () => {
      await api("/preferences", { body: { key, value } });
      await reload();
      toast("Preference saved. Calculations use it from now on.");
    }).finally(() =>
      setPending((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      }),
    );
  };
  const toggleBenefit = (b: string) => setPref("protected_benefits", protectedB.includes(b) ? protectedB.filter((x) => x !== b) : [...protectedB, b]);
  const markRead = () =>
    run(async () => {
      await api("/notifications/read", { body: {} });
      await reload();
    });

  return (
    <>
      <PageHead back="/agent" title="Monitoring and alerts" sub="What NextMove checks for you, what it may read, and the preferences it uses. Monitoring only reads; it never changes anything." />

      <Section title="Alerts" id="alerts" action={unread ? <button type="button" className="btn text small-btn" onClick={markRead} disabled={busy}>Mark all read</button> : undefined}>
        <Group>
          {data.notifications.length ? (
            data.notifications.map((n: any) => (
              <Row
                key={n.id}
                href={n.link ?? undefined}
                mark={<span className="mark" aria-hidden="true"><Icon.bell size={20} /></span>}
                title={n.read_at ? n.title : <strong>{n.title}</strong>}
                sub={
                  <>
                    {n.body}
                    <span className="caption" style={{ display: "block", marginTop: 2 }}>
                      {n.read_at ? "" : "New, "}
                      {dayTime(onDemoClock(n.created_at, demoOffset))}
                    </span>
                  </>
                }
              />
            ))
          ) : (
            <Empty>No alerts yet. NextMove tells you here when something you monitor needs a decision.</Empty>
          )}
        </Group>
      </Section>

      {findings.length ? (
        <Section title="Worth a look" id="findings">
          <Group>
            {findings.map((f: any) => (
              <Row key={f.id} href={CAP_LINK.test(f.task_kind ?? "") ? `/capabilities/${f.task_kind}` : undefined} title={f.title} sub={f.body} />
            ))}
          </Group>
        </Section>
      ) : null}

      <Section title="What NextMove checks" id="watches">
        <Group>
          {data.watches.length ? (
            data.watches.map((w: any) => (
              <Row
                key={w.id}
                title={w.label}
                sub={
                  <>
                    {w.last_result && w.status === "ACTIVE" ? <span style={{ display: "block" }}>{String(w.last_result).slice(0, 80)}</span> : null}
                    {w.status === "ACTIVE" ? (
                      <StateLine tone="ok" icon="check">
                        Next check {dayTime(w.next_check_at)}
                      </StateLine>
                    ) : (
                      <StateLine icon="stop">{w.status === "REVOKED" ? "Stopped: you revoked the permission" : w.status === "DONE" ? `Finished${w.last_result ? `: ${String(w.last_result).slice(0, 60)}` : ""}` : "Paused"}</StateLine>
                    )}
                  </>
                }
              />
            ))
          ) : (
            <Empty>Nothing is being monitored in this context</Empty>
          )}
        </Group>
      </Section>

      <Section title="Permissions" id="permissions">
        <Group>
          {data.permissions.map((p: any) => (
            <div className="row" key={p.id}>
              <div className="row-main">
                <div className="row-title">{p.source}</div>
                <div className="row-sub">
                  {p.kind === "MONITOR" ? "Monitor" : "Read"}: {p.scope}
                </div>
                <div className="row-sub">{p.status === "ACTIVE" ? (p.expires_at ? `Until ${date(p.expires_at)}` : "Until you revoke it") : `Revoked ${dayTime(onDemoClock(p.revoked_at, demoOffset))}`}</div>
              </div>
              {p.status === "ACTIVE" ? (
                <button type="button" className="btn small-btn" onClick={() => revoke(p)} disabled={busy} aria-label={`Revoke ${p.source}`}>
                  Revoke
                </button>
              ) : (
                <StateLine icon="stop">Revoked</StateLine>
              )}
            </div>
          ))}
        </Group>
        <p className="caption" style={{ margin: "8px 0 0" }}>
          Revoking stops future checks at once. It does not undo changes you already approved.
        </p>
      </Section>

      {!business ? (
        <Section title="Preferences" id="preferences">
          <div className="group">
            <label className="row check-row">
              <input type="checkbox" checked={protectedB.includes("offline_playback")} onChange={() => toggleBenefit("offline_playback")} />
              <span className="row-main">
                <span className="row-title">Keep offline downloads</span>
                <span className="row-sub">Never suggest a plan that removes offline playback</span>
              </span>
            </label>
            <label className="row check-row">
              <input type="checkbox" checked={protectedB.includes("tv_access")} onChange={() => toggleBenefit("tv_access")} />
              <span className="row-main">
                <span className="row-title">Keep watching on the TV</span>
                <span className="row-sub">Never suggest a plan that removes TV access</span>
              </span>
            </label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <div className="row-main" style={{ minWidth: 180 }}>
                <div className="row-title">Phone hotspot</div>
                <div className="row-sub">{hotspot === null ? "Not answered: NextMove asks before changing the phone plan" : hotspot ? "You need it" : "You don't need it"}</div>
              </div>
              <div className="seg" role="group" aria-label="Phone hotspot" style={{ margin: 0, padding: 0 }}>
                <button type="button" aria-pressed={hotspot === true} onClick={() => setPref("hotspot_required", true)} disabled={busy}>
                  Need it
                </button>
                <button type="button" aria-pressed={hotspot === false} onClick={() => setPref("hotspot_required", false)} disabled={busy}>
                  Don't need
                </button>
              </div>
            </div>
          </div>
        </Section>
      ) : null}
      <ErrorBox error={actError} />
    </>
  );
}
