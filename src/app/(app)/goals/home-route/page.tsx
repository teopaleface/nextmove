"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ErrorBox, Group, Loading, Notice, PageHead, Row, Section, Sources, StateLine, useAction } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { date, short } from "@/ui/format";
import { RouteMap } from "@/ui/route-map";
import styles from "./route.module.css";

// O6: the live route to Alex's home goal. Roadblocks are Labs events; every number comes from GET /capabilities/O6.

const MIN_RECALC_MS = 800;

type Reroute = {
  id: string;
  title: string;
  summary: string;
  verdict: "OK" | "REJECTED" | "UNAVAILABLE";
  reason: string | null;
  action: "PROPOSAL" | "PLAN_CHANGE" | null;
  arrival: string;
  arrivalMonth: number | null;
  delayMonths: number | null;
  impact: string;
  reserve: string;
  spareMinor: number | null;
  fictional: boolean;
  sources: { capability: string; label: string; amountMinor: number }[];
  points: number[];
};

function later(n: number | null) {
  if (n == null) return "";
  if (n <= 0) return "Same date";
  return `${n} month${n > 1 ? "s" : ""} later`;
}

export default function HomeRoutePage() {
  const router = useRouter();
  const { epoch, toast } = useSession();
  const { data, error, reload, setData } = useApi<any>("/capabilities/O6", { epoch });
  const [recalculating, setRecalculating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const act = useAction();
  const route = data?.route;
  const active: string[] = route ? route.roadblocks.filter((r: any) => r.active).map((r: any) => r.id) : [];
  const routeSig = route ? `${active.join(",")}|${route.current.points.join(",")}` : "";

  useEffect(() => {
    setSelected(route?.recommended ?? null);
  }, [routeSig]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && error.code === "WRONG_CONTEXT")
    return (
      <>
        <PageHead back="/goals" title="Route to your home" />
        <Notice tone="info">{error.message}. Use the context switcher at the top of the screen.</Notice>
      </>
    );
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Planning your route…" />;
  if (!route)
    return (
      <>
        <PageHead back="/goals" title="Route to your home" />
        <Notice tone="warn">{data.headline}</Notice>
      </>
    );

  const recalc = (path: string, body: object) =>
    act.run(async () => {
      setRecalculating(true);
      const started = Date.now();
      try {
        const r = await api<any>(path, { body });
        const wait = MIN_RECALC_MS - (Date.now() - started);
        if (wait > 0) await new Promise((res) => setTimeout(res, wait));
        setData(r.analysis);
      } finally {
        setRecalculating(false);
      }
    });

  const toggle = (id: string, on: boolean) => recalc("/goals/home-route/roadblocks", { id, on });
  const reset = () => recalc("/goals/home-route/reset", {});

  const choose = (r: Reroute) =>
    act.run(async () => {
      const out = await api<any>("/goals/home-route/choose", { body: { route: r.id } });
      if (out.proposalId) router.push(`/review/${encodeURIComponent(out.proposalId)}`);
      else {
        toast(`Route ${r.id} saved to your plan`);
        await reload();
      }
    });

  const reroutes: Reroute[] = route.reroutes;
  const preview = reroutes.find((r) => r.id === selected && r.points.length) ?? null;
  const shown = preview ?? { points: route.current.points, arrival: route.current.arrival, arrivalMonth: route.current.arrivalMonth, verdict: "OK" as const };
  const changed = active.length > 0;
  const delayed = route.current.delayMonths > 0;
  const reaches = shown.verdict !== "REJECTED";
  const mapMonths = route.months.slice(0, Math.max(shown.points.length, route.original.points.length));
  const status = recalculating ? (
    <StateLine tone="neutral" icon="clock">
      Recalculating route…
    </StateLine>
  ) : !changed ? (
    <StateLine tone="ok">On route</StateLine>
  ) : delayed ? (
    <StateLine tone="warn">Rerouted, {later(route.current.delayMonths).toLowerCase()}</StateLine>
  ) : (
    <StateLine tone="ok">Still on route</StateLine>
  );
  const pick = reroutes.find((r) => r.id === selected) ?? null;
  const prev = (i: number) => (i ? shown.points[i - 1] : null);

  return (
    <>
      <PageHead back="/goals" title="Route to your home" sub={`From today's ${short(route.startMinor)} to the ${route.goalName.toLowerCase()} target. The ${short(route.reserveMinor)} reserve is never used.`} />

      <section className={styles.card} aria-labelledby="arrival-title" aria-busy={recalculating}>
        <div className={styles.cardHead}>
          <span className="caption">{preview && preview.id !== route.recommended ? `Arrival on route ${preview.id}` : "Arrival"}</span>
          <span aria-live="polite">{status}</span>
        </div>
        <h2 id="arrival-title" className={styles.arrival} key={`${shown.arrival}-${routeSig}`} data-dimmed={recalculating ? "true" : undefined}>
          {shown.arrival}
        </h2>
        <p className={styles.meta} data-dimmed={recalculating ? "true" : undefined}>
          {changed && shown.arrival !== route.original.arrival ? <span>Was {route.original.arrival}. </span> : null}
          {preview && preview.verdict === "REJECTED" ? "Rejected: it breaks the reserve." : <>{short(preview ? Math.max(0, preview.spareMinor ?? 0) : route.current.spareMinor)} spare on arrival</>}
          {changed ? <> · roadblocks {short(route.current.hitMinor)}</> : null}
        </p>
        <RouteMap
          months={mapMonths}
          targetMinor={route.targetMinor}
          points={shown.points}
          ghost={changed ? route.original.points : null}
          routeKey={`${routeSig}|${selected ?? ""}`}
          dimmed={recalculating}
          reaches={reaches}
          summary={`Route from ${short(shown.points[0])} today to ${short(shown.points[shown.points.length - 1])} in ${shown.arrival}. Home target ${short(route.targetMinor)}.${changed ? ` Original arrival ${route.original.arrival}.` : ""}`}
        />
        {changed ? (
          <div className={styles.legend} aria-hidden="true">
            <span>
              <i className={styles.keyLine} /> {preview ? `Route ${preview.id}` : "New route"}
            </span>
            <span>
              <i className={styles.keyGhost} /> Original
            </span>
          </div>
        ) : null}
      </section>

      <Section
        title="Roadblocks"
        id="roadblocks"
        action={
          changed && route.labs ? (
            <button type="button" className="btn text" onClick={reset} disabled={act.busy}>
              Reset route
            </button>
          ) : null
        }
      >
        <p className="caption" style={{ margin: "0 0 12px" }}>
          Labs: simulated events for this demo customer. Nothing is charged.
        </p>
        <div className="chips" role="group" aria-label="Roadblocks">
          {route.roadblocks.map((r: any) => (
            <button key={r.id} type="button" className="chip" aria-pressed={r.active} disabled={!route.labs || act.busy} onClick={() => toggle(r.id, !r.active)} title={r.detail}>
              {r.active ? <Icon.check size={16} /> : <Icon.plus size={16} />}
              {r.label}
            </button>
          ))}
        </div>
        {!route.labs ? <p className="caption">Labs controls are off in the bank demo.</p> : null}
      </Section>

      <ErrorBox error={act.error} />

      {changed ? (
        <Section title="Reroutes" id="reroutes">
          <p className="caption" style={{ margin: "0 0 12px" }}>
            {reroutes.length} routes checked against your balances and the reserve. Tap one to see it on the map.
          </p>
          <Group>
            {reroutes.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`row ${styles.option}`}
                aria-pressed={selected === r.id}
                disabled={r.verdict === "UNAVAILABLE"}
                onClick={() => setSelected(r.id)}
              >
                <span className={styles.letter} aria-hidden="true">
                  {r.id}
                </span>
                <span className="row-main">
                  <span className="row-title">
                    {r.title}
                    {r.fictional ? <span className="caption"> · fictional plan</span> : null}
                  </span>
                  <span className="row-sub">{r.verdict === "UNAVAILABLE" ? r.reason : r.impact}</span>
                  {r.verdict === "REJECTED" ? (
                    <StateLine tone="bad">Rejected: breaks the reserve</StateLine>
                  ) : r.verdict === "OK" ? (
                    <StateLine tone="ok" icon="check">
                      {r.id === route.recommended ? `Best route · reserve kept` : "Reserve kept"}
                    </StateLine>
                  ) : null}
                </span>
                {r.verdict !== "UNAVAILABLE" ? (
                  <span className="row-end">
                    <span className="row-amount">{r.arrival}</span>
                    <span className="row-sub">{later(r.delayMonths)}</span>
                  </span>
                ) : null}
                {r.verdict === "REJECTED" ? <span className={`row-sub ${styles.why}`}>{r.reason}</span> : null}
              </button>
            ))}
          </Group>

          {pick && pick.verdict === "OK" ? (
            <div className={styles.decide}>
              <p className="small" style={{ margin: 0 }}>
                {pick.summary}
              </p>
              {pick.sources.length ? (
                <>
                  <div className={styles.sources}>
                    <Group>
                      {pick.sources.map((x) => (
                        <Row key={x.capability} href={`/capabilities/${x.capability}`} title={x.label} sub={`Found by ${x.capability}`} end={short(x.amountMinor)} />
                      ))}
                    </Group>
                  </div>
                  <p className="caption" style={{ margin: "8px 0 0" }}>
                    Only charges these checks computed for the next 30 days are counted.
                  </p>
                </>
              ) : null}
              <button type="button" className="btn primary main block" style={{ marginTop: 16 }} disabled={act.busy || recalculating || !pick.action} onClick={() => choose(pick)}>
                {pick.action === "PROPOSAL" ? `Review ${pick.sources.length} change${pick.sources.length === 1 ? "" : "s"}` : `Use route ${pick.id}`}
              </button>
              <p className="caption" style={{ margin: "8px 0 0", textAlign: "center" }}>
                {pick.action === "PROPOSAL" ? "Nothing changes until you approve each one." : "Saved to your plan. No money moves."}
              </p>
            </div>
          ) : null}
        </Section>
      ) : null}

      {route.choice ? (
        <div style={{ marginTop: 16 }}>
          <Notice tone="info" title="Your choice">
            {route.choice.label}. Saved {date(route.choice.at)}.{" "}
            {route.choice.proposalId ? (
              <Link className="link" href={`/review/${encodeURIComponent(route.choice.proposalId)}`}>
                Open the review
              </Link>
            ) : (
              "No money moved."
            )}
          </Notice>
        </div>
      ) : null}

      <Section title="Checkpoints" id="checkpoints">
        <Group>
          {shown.points.map((p: number, i: number) => {
            const last = i === shown.points.length - 1;
            const delta = prev(i) == null ? null : p - (prev(i) as number);
            return (
              <div className="row" key={i}>
                <span className={styles.step} data-kind={i === 0 ? "start" : last ? (reaches ? "end" : "miss") : undefined} aria-hidden="true" />
                <div className="row-main">
                  <div className="row-title">{route.months[i]?.label ?? `Month ${i}`}</div>
                  <div className="row-sub">{i === 0 ? "All your accounts today" : last && reaches ? "Home target reached" : last ? "Short of the target" : `Checkpoint ${i}`}</div>
                </div>
                <div className="row-end">
                  <div className="row-amount num">{short(p)}</div>
                  {delta != null ? <div className="row-sub num">{delta >= 0 ? "+" : "−"}{short(Math.abs(delta)).replace(" RON", "")}</div> : null}
                </div>
              </div>
            );
          })}
        </Group>
        <p className="caption" style={{ margin: "8px 0 0" }}>
          Same inputs as the home plan: {short(route.contributionMinor)} a month, no growth or interest. A planning model, not a mortgage approval.
        </p>
        <Sources codes={data.evidence} />
      </Section>
    </>
  );
}
