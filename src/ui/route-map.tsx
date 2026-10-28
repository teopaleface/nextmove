"use client";

import { short } from "./format";
import styles from "./route-map.module.css";

// The goal route as a small chart: monthly checkpoints from today's funds up to the home target. The original
// route stays as a dashed ghost after a reroute. The path is redrawn (keyed) whenever the route changes; motion is
// CSS-only and removed under prefers-reduced-motion.

export function RouteIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="18" r="2" />
      <path d="M8 18h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16" />
      <path d="m15 2 2 2-2 2" />
    </svg>
  );
}

const W = 340;
const H = 176;
const PAD = { l: 12, r: 18, t: 30, b: 26 };

export function RouteMap(props: {
  months: { month: number; short: string; label: string }[];
  targetMinor: number;
  points: number[];
  ghost?: number[] | null;
  routeKey: string;
  dimmed?: boolean;
  reaches: boolean;
  summary: string;
}) {
  const { months, targetMinor, points, ghost } = props;
  const all = [...points, ...(ghost ?? []), targetMinor];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = Math.max(1, hi - lo);
  const yMin = lo - span * 0.12;
  const yMax = hi + span * 0.1;
  const maxMonth = Math.max(1, months.length - 1);
  const x = (m: number) => PAD.l + (m * (W - PAD.l - PAD.r)) / maxMonth;
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const d = (pts: number[]) => pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const end = points.length - 1;
  const ty = y(targetMinor);

  return (
    <figure className={styles.figure} data-dimmed={props.dimmed ? "true" : undefined}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label={props.summary}>
        <line x1={PAD.l} x2={W - PAD.r + 6} y1={ty} y2={ty} className={styles.target} />
        <text x={PAD.l} y={ty - 8} className={styles.targetLabel}>
          Home target {short(targetMinor)}
        </text>
        {months.map((m) => (
          <text key={m.month} x={x(m.month)} y={H - 6} className={styles.tick} textAnchor={m.month === 0 ? "start" : m.month === maxMonth ? "end" : "middle"}>
            {m.short}
          </text>
        ))}
        {ghost ? <path d={d(ghost)} className={styles.ghost} /> : null}
        <g key={props.routeKey} className={styles.route}>
          <path d={d(points)} pathLength={1} className={styles.path} />
          {points.slice(0, end).map((v, i) => (
            <circle key={i} cx={x(i)} cy={y(v)} r={i === 0 ? 4.5 : 3.5} className={i === 0 ? styles.start : styles.dot} style={{ animationDelay: `${120 + (i / Math.max(1, end)) * 520}ms` }} />
          ))}
          <circle cx={x(end)} cy={y(points[end])} r={7} className={props.reaches ? styles.arrival : styles.miss} />
        </g>
      </svg>
      <figcaption className="sr-only">{props.summary}</figcaption>
    </figure>
  );
}
