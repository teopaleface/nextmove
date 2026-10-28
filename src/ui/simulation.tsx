"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentSig, Icon } from "./icons";
import { StateLine } from "./kit";
import { clampValues, evaluate, formatPct, formatRon, initialValues, monthLabel, type Outcome, type Simulation, type Slider, type Values } from "../shared/simulations";
import s from "./simulation.module.css";

// Interactive what-if inside an agent answer or a goal analysis. The server sends the starting numbers (from
// records and NextMove's calculations); slider changes recompute here with the same pure functions. Nothing is
// sent back: moving a slider never changes an account, a goal or a proposal.

const TONE = { good: "ok", warn: "warn", bad: "bad", neutral: "neutral" } as const;

function sliderText(sl: Slider, v: number) {
  switch (sl.unit) {
    case "money":
      return formatRon(v);
    case "months":
      return `${v} months`;
    case "years":
      return `${v} year${v === 1 ? "" : "s"}`;
    case "percent":
      return `${sl.min < 0 && v > 0 ? "+" : v < 0 ? "−" : ""}${formatPct(Math.abs(v))}`;
  }
}

export function SimulationWidget({ sim }: { sim: Simulation }) {
  const start = useMemo(() => initialValues(sim), [sim]);
  const [values, setValues] = useState<Values>(start);
  const outcome = useMemo(() => evaluate(sim, values), [sim, values]);
  const id = useId();
  const changed = sim.sliders.some((sl) => values[sl.key] !== start[sl.key]);
  const fictional = sim.kind === "invest" ? "Illustration, not a promise; fictional rate." : sim.kind === "loan" ? "Fictional rate. Not a loan offer or a credit decision." : "Planning model, not advice.";

  return (
    <section className={`group ${s.card}`} aria-labelledby={`${id}-t`}>
      <div className={s.head}>
        <AgentSig label="What-if · recalculates as you move" />
        <h3 id={`${id}-t`} className={s.title}>
          {sim.title}
        </h3>
        <div aria-live="polite" aria-atomic="true">
          <p className={`num ${s.headline}`}>{outcome.headline}</p>
          <StateLine tone={TONE[outcome.tone]}>{outcome.sub}</StateLine>
        </div>
      </div>

      <figure className={s.figure}>
        <Chart sim={sim} outcome={outcome} summaryId={`${id}-sum`} />
        <figcaption>
          <ul className={s.legend}>
            {outcome.chart.series.map((se) => (
              <li key={se.key}>
                <span className={se.emphasis === "primary" ? s.keyPrimary : s.keyRef} aria-hidden="true" />
                {se.label}
              </li>
            ))}
            {outcome.chart.target != null ? (
              <li>
                <span className={s.keyTarget} aria-hidden="true" />
                Home target
              </li>
            ) : null}
          </ul>
          <p id={`${id}-sum`} className="sr-only">
            {outcome.summary}
          </p>
          <p className={`caption ${s.fictional}`}>{fictional}</p>
        </figcaption>
      </figure>

      <div className={s.controls}>
        {sim.sliders.map((sl) => (
          <SliderField key={sl.key} id={`${id}-${sl.key}`} slider={sl} value={values[sl.key]} onChange={(v) => setValues((cur) => clampValues(sim, { ...cur, [sl.key]: v }))} />
        ))}
      </div>

      <dl className={s.lines}>
        {outcome.lines.map((l) => (
          <div key={l.label} className="kv">
            <dt>{l.label}</dt>
            <dd>{l.text ?? (l.unit === "money" ? formatRon(l.value) : String(l.value))}</dd>
          </div>
        ))}
      </dl>

      <details className={s.more}>
        <summary>Where the numbers come from</summary>
        <ul>
          {sim.sources.map((x) => (
            <li key={x}>{x}</li>
          ))}
          {sim.assumptions.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </details>

      {changed ? (
        <div className={s.foot}>
          <button type="button" className="btn text" onClick={() => setValues(start)}>
            <Icon.refresh size={16} /> Back to NextMove's numbers
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SliderField({ id, slider, value, onChange }: { id: string; slider: Slider; value: number; onChange: (v: number) => void }) {
  const p = ((value - slider.min) / (slider.max - slider.min || 1)) * 100;
  const text = sliderText(slider, value);
  return (
    <div className={s.slider}>
      <div className={s.sliderHead}>
        <label htmlFor={id}>{slider.label}</label>
        <output htmlFor={id} className="num">
          {text}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className={s.range}
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={value}
        aria-valuetext={text}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--p": `${p}%` } as React.CSSProperties}
      />
      <div className={`caption num ${s.ends}`} aria-hidden="true">
        <span>{sliderText(slider, slider.min)}</span>
        <span>{sliderText(slider, slider.max)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- chart */

/** Drop axis labels that would touch the previous one; the last label (the result) always stays. */
function spaced(xs: number[], X: (x: number) => number, width: number) {
  const min = width < 340 ? 52 : 46;
  const out: number[] = [];
  xs.forEach((x, i) => {
    const last = i === xs.length - 1;
    while (last && out.length && X(x) - X(out[out.length - 1]) < min && out[out.length - 1] !== 0) out.pop();
    if (!out.length || X(x) - X(out[out.length - 1]) >= min || last) out.push(x);
  });
  return out;
}

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const H = 176;
const PAD = { top: 26, right: 8, bottom: 28, left: 8 };

function Chart({ sim, outcome, summaryId }: { sim: Simulation; outcome: Outcome; summaryId: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(288);
  const c = outcome.chart;
  const all = c.series.flatMap((se) => se.points);
  const xMax = Math.max(4, ...all.map((p) => p.x)) + (c.xUnit === "month" ? 1 : 0);
  let yMin = c.xUnit === "year" ? 0 : Math.min(...all.map((p) => p.y));
  let yMax = Math.max(c.target ?? 0, ...all.map((p) => p.y), 1);
  const span = yMax - yMin || yMax || 1;
  if (c.xUnit === "month") yMin -= span * 0.1;
  yMax += span * 0.06;
  const iw = Math.max(1, width - PAD.left - PAD.right);
  const ih = H - PAD.top - PAD.bottom;
  const X = (x: number) => PAD.left + (x / xMax) * iw;
  const Y = (y: number) => PAD.top + (1 - (y - yMin) / (yMax - yMin || 1)) * ih;
  const line = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  const primary = c.series.find((se) => se.emphasis === "primary")!;
  const anchor = (x: number) => (X(x) < PAD.left + 36 ? "start" : X(x) > width - PAD.right - 36 ? "end" : "middle");
  const xLabel = (x: number) => (x === 0 ? "Now" : c.xUnit === "month" ? monthLabel(sim.asOf, x, "short") : `${x} yr${x === 1 ? "" : "s"}`);
  const ticks = c.xUnit === "year" ? [0, ...c.marks.map((m) => m.x), ...(c.marks.some((m) => m.x === xMax) ? [] : [xMax])] : [0, ...c.marks.map((m) => m.x)];
  const lastMark = c.marks.at(-1);

  return (
    <div ref={ref} className={s.chart}>
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-describedby={summaryId} aria-label={`Chart: ${sim.title}`}>
        <line x1={PAD.left} x2={width - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} className={s.axis} />
        {xMax <= 60 ? Array.from({ length: xMax + 1 }, (_, x) => <line key={x} x1={X(x)} x2={X(x)} y1={H - PAD.bottom} y2={H - PAD.bottom + 4} className={s.tick} />) : null}
        {c.target != null ? (
          <g>
            <line x1={PAD.left} x2={width - PAD.right} y1={Y(c.target)} y2={Y(c.target)} className={s.target} />
            <text x={PAD.left} y={Y(c.target) - 7} className={s.label}>
              Target {formatRon(c.target)}
            </text>
          </g>
        ) : null}
        {c.xUnit === "year" ? <path d={`${line(primary.points)}L${X(primary.points.at(-1)!.x)},${Y(0)}L${X(0)},${Y(0)}Z`} className={s.area} /> : null}
        {c.series.map((se) => (
          <path key={se.key} d={line(se.points)} className={se.emphasis === "primary" ? s.primary : s.reference} />
        ))}
        {c.marks.map((m) => {
          const pt = primary.points.find((p) => p.x === m.x);
          if (!pt) return null;
          return (
            <g key={m.x}>
              {c.xUnit === "month" ? <line x1={X(pt.x)} x2={X(pt.x)} y1={Y(pt.y) + 6} y2={H - PAD.bottom} className={s.guide} /> : null}
              <circle cx={X(pt.x)} cy={Y(pt.y)} r={m === lastMark || c.xUnit === "month" ? 5 : 3.5} className={c.xUnit === "month" || m === lastMark ? s.dot : s.dotSmall} />
            </g>
          );
        })}
        {spaced([...new Set(ticks)], X, width).map((x) => (
          <text key={x} x={X(x)} y={H - 8} textAnchor={anchor(x)} className={s.label}>
            {xLabel(x)}
          </text>
        ))}
      </svg>
    </div>
  );
}
