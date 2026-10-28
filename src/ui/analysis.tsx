"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { ErrorBox, Group, Notice, StateLine, useAction, Sources } from "./kit";
import { ROUTE_LABEL, dayTime, money } from "./format";
import { SimulationWidget } from "./simulation";
import type { Simulation } from "../shared/simulations";

const fmtAt = (v: string) => (/^\d{4}-\d{2}-\d{2}T/.test(v) ? dayTime(v) : v);
const fmtState = (v: string) => (/^[A-Z_]+$/.test(v) ? v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, " ") : v);

// Renders a server-computed capability analysis: blocks, editable inputs and the server-built candidate actions.
// The client never builds an action; it only names candidate keys and the server recomputes everything.

export type Block =
  | { kind: "metrics"; items: { label: string; value: string; sub?: string; tone?: string }[] }
  | { kind: "table"; title: string; columns: string[]; rows: { cells: string[]; highlight?: boolean; tone?: string }[]; note?: string }
  | { kind: "conditions"; title: string; items: { label: string; state: "met" | "unmet" | "unknown"; detail?: string }[] }
  | { kind: "timeline"; title: string; items: { at: string; label: string; amount?: string; state?: string }[] }
  | { kind: "facts"; title: string; items: { label: string; value: string; provenance: string }[] }
  | { kind: "note"; tone: "info" | "warn"; text: string }
  | { kind: "question"; id: string; text: string; options: { value: string; label: string }[]; answer: string | null }
  | { kind: "status"; title: string; state: string; detail?: string; href?: string }
  | { kind: "simulation"; simulation: Simulation };

export function BlockView({ block, onAnswer }: { block: Block; onAnswer?: (id: string, value: string) => void }) {
  switch (block.kind) {
    case "metrics":
      return (
        <div className={`split analysis-metrics${block.items.length === 1 ? " single" : ""}`}>
          {block.items.map((m, i) => (
            <div key={i} className="group pad">
              <div className="small muted">{m.label}</div>
              <div className="num analysis-metric-value" style={{ color: m.tone === "bad" ? "var(--danger)" : m.tone === "good" ? "var(--success)" : undefined }}>
                {m.value}
              </div>
              {m.sub ? <div className="caption" style={{ marginTop: 2 }}>{m.sub}</div> : null}
            </div>
          ))}
        </div>
      );
    case "table":
      return (
        <div>
          <h3 className="label" style={{ margin: "0 0 8px" }}>
            {block.title}
          </h3>
          <Group>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {block.columns.map((c) => (
                      <th key={c} scope="col">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((r, i) => (
                    <tr key={i} className={r.highlight ? "hl" : undefined}>
                      {r.cells.map((c, j) => (
                        <td key={j} style={{ color: r.tone === "bad" && j === 0 ? "var(--danger)" : undefined }}>
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Group>
          {block.note ? (
            <p className="caption" style={{ margin: "8px 0 0" }}>
              {block.note}
            </p>
          ) : null}
        </div>
      );
    case "conditions":
      return (
        <div>
          <h3 className="label" style={{ margin: "0 0 8px" }}>
            {block.title}
          </h3>
          <Group>
            {block.items.map((c, i) => (
              <div key={i} className="row" style={{ alignItems: "flex-start" }}>
                <span style={{ paddingTop: 2, color: c.state === "met" ? "var(--success)" : c.state === "unmet" ? "var(--danger)" : "var(--warning)" }}>
                  {c.state === "met" ? <Icon.checkCircle size={20} /> : c.state === "unmet" ? <Icon.xCircle size={20} /> : <Icon.warning size={20} />}
                </span>
                <div className="row-main">
                  <div className="row-title">{c.label}</div>
                  <div className="row-sub">{c.detail ?? (c.state === "met" ? "Met" : c.state === "unmet" ? "Not met" : "Not known yet")}</div>
                </div>
              </div>
            ))}
          </Group>
        </div>
      );
    case "timeline":
      return (
        <div>
          <h3 className="label" style={{ margin: "0 0 8px" }}>
            {block.title}
          </h3>
          <Group>
            {block.items.map((t, i) => (
              <div key={i} className="row">
                <div className="row-main">
                  <div className="row-title">{t.label}</div>
                  <div className="row-sub">
                    {fmtAt(t.at)}
                    {t.state ? `, ${fmtState(t.state)}` : ""}
                  </div>
                </div>
                {t.amount ? <div className="row-end row-amount">{t.amount}</div> : null}
              </div>
            ))}
          </Group>
        </div>
      );
    case "facts":
      return (
        <div>
          <h3 className="label" style={{ margin: "0 0 8px" }}>
            {block.title}
          </h3>
          <Group>
            {block.items.map((f, i) => (
              <div key={i} className="kv">
                <dt className="small muted">
                  {f.label}
                  <div className="caption">{f.provenance}</div>
                </dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </Group>
        </div>
      );
    case "note":
      return <Notice tone={block.tone === "warn" ? "warn" : "info"}>{block.text}</Notice>;
    case "question":
      return (
        <div className="group pad">
          <div className="label">{block.text}</div>
          <div className="chips" style={{ marginTop: 10 }} role="group" aria-label={block.text}>
            {block.options.map((o) => (
              <button key={o.value} type="button" className="chip" aria-pressed={block.answer === o.value} onClick={() => onAnswer?.(block.id, o.value)} disabled={!onAnswer}>
                {block.answer === o.value ? <Icon.check size={16} /> : null}
                {o.label}
              </button>
            ))}
          </div>
        </div>
      );
    case "status":
      return (
        <div className="group">
          {block.href ? (
            <Link className="row" href={block.href}>
              <div className="row-main">
                <div className="row-title">{block.title}</div>
                <div className="row-sub">{block.detail}</div>
              </div>
              <Icon.chevronRight size={20} className="chev" />
            </Link>
          ) : (
            <div className="row">
              <div className="row-main">
                <div className="row-title">{block.title}</div>
                <div className="row-sub">{block.detail}</div>
              </div>
            </div>
          )}
        </div>
      );
    case "simulation":
      return <SimulationWidget sim={block.simulation} />;
    default:
      return null;
  }
}

export interface InputField {
  key: string;
  label: string;
  type: "money" | "number" | "select" | "toggle" | "text";
  value: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  suffix?: string;
  help?: string;
}

/** Editable assumptions. Money is edited in RON and sent to the server in bani. */
export function InputsForm({ fields, onApply, busy }: { fields: InputField[]; onApply: (values: Record<string, unknown>) => void; busy?: boolean }) {
  const initial = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f.type === "money" ? (f.value == null ? "" : String(Number(f.value) / 100)) : f.value ?? ""])), [fields]);
  const [values, setValues] = useState<Record<string, any>>(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.key];
      if (f.type === "money") {
        if (v === "" || v == null) out[f.key] = null;
        else {
          const n = Number(String(v).replace(/,/g, ""));
          if (!Number.isFinite(n) || n < 0) return setError(`${f.label}: enter an amount in RON`);
          out[f.key] = Math.round(n * 100);
        }
      } else if (f.type === "number") {
        const n = Number(v);
        if (!Number.isFinite(n)) return setError(`${f.label}: enter a number`);
        out[f.key] = n;
      } else if (f.type === "toggle") out[f.key] = Boolean(v);
      else out[f.key] = v;
    }
    setError(null);
    onApply(out);
  };
  return (
    <form onSubmit={submit}>
      <div className="group">
        {fields.map((f) => (
          <div key={f.key} className="field">
            <label htmlFor={`in-${f.key}`}>{f.label}</label>
            {f.type === "select" ? (
              <select id={`in-${f.key}`} className="select" value={String(values[f.key] ?? "")} onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === "toggle" ? (
              <label className="check-row" style={{ padding: 0, minHeight: 44 }}>
                <input id={`in-${f.key}`} type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.checked }))} />
                <span className="small">{values[f.key] ? "Yes" : "No"}</span>
              </label>
            ) : (
              <div className="input-wrap">
                <input
                  id={`in-${f.key}`}
                  className="input"
                  inputMode={f.type === "text" ? "text" : "decimal"}
                  value={String(values[f.key] ?? "")}
                  onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.type === "money" ? "Not known" : undefined}
                  style={f.suffix || f.type === "money" ? { paddingRight: 64 } : undefined}
                />
                {f.type === "money" || f.suffix ? <span className="suffix">{f.type === "money" ? "RON" : f.suffix}</span> : null}
              </div>
            )}
            {f.help ? <div className="help">{f.help}</div> : null}
          </div>
        ))}
      </div>
      {error ? (
        <p className="small" role="alert" style={{ color: "var(--danger)", margin: "8px 0 0" }}>
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" className="btn block" disabled={busy}>
          {busy ? "Recalculating…" : "Recalculate"}
        </button>
      </div>
    </form>
  );
}

export interface Candidate {
  key: string;
  spec: any;
  defaultSelected: boolean;
  available: boolean;
  unavailableReason?: string;
}

/** Choose among server-built candidate actions and turn the selection into a proposal for exact approval. */
export function CandidatePicker({ capabilityId, candidates, inputs, taskId }: { capabilityId: string; candidates: Candidate[]; inputs: Record<string, unknown>; taskId?: string | null }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.filter((c) => c.defaultSelected && c.available).map((c) => c.key)));
  const { run, busy, error } = useAction();
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else {
        n.add(k);
        for (const d of byKey.get(k)?.spec.dependsOn ?? []) if (byKey.get(d)?.available) n.add(d);
      }
      return n;
    });
  const propose = () =>
    run(async () => {
      const p = await api<any>(`/capabilities/${capabilityId}/propose`, { body: { keys: [...selected], inputs, taskId } });
      router.push(`/review/${p.id}`);
    });
  if (!candidates.length) return null;
  return (
    <div>
      <div className="group">
        {candidates.map((c) => {
          const s = c.spec;
          const deps = (s.dependsOn ?? []).map((d: string) => byKey.get(d)?.spec.display.title).filter(Boolean);
          return (
            <label key={c.key} className="check-row" style={{ opacity: c.available ? 1 : 0.75 }}>
              <input type="checkbox" checked={selected.has(c.key)} onChange={() => toggle(c.key)} disabled={!c.available} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="row-title" style={{ display: "block" }}>
                  {s.display.title}
                </span>
                <span className="row-sub" style={{ display: "block" }}>
                  {s.display.summary}
                </span>
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: 4 }}>
                  <span className="caption">{ROUTE_LABEL[s.route] ?? s.route}</span>
                  {s.money.immediateDebitMinor ? <span className="caption">Pays {money(s.money.immediateDebitMinor)} now</span> : null}
                  {s.money.forecastChangeMinor ? <span className="caption">{s.money.forecastChangeMinor < 0 ? `${money(-s.money.forecastChangeMinor)} less due` : `${money(s.money.forecastChangeMinor)} more due`}</span> : null}
                </span>
                {deps.length ? (
                  <span className="caption" style={{ display: "block", marginTop: 2 }}>
                    Needs first: {deps.join(", ")}
                  </span>
                ) : null}
                {!c.available ? (
                  <span style={{ display: "block", marginTop: 4 }}>
                    <StateLine tone="warn">{c.unavailableReason ?? "Not available"}</StateLine>
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      <div className="actions">
        <button type="button" className="btn primary block main" onClick={propose} disabled={busy || selected.size === 0}>
          {busy ? "Preparing…" : selected.size > 1 ? `Review ${selected.size} actions` : "Review this action"}
        </button>
        <p className="caption" style={{ margin: 0, textAlign: "center" }}>
          Nothing is sent until you approve the exact details on the next screen.
        </p>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

export function AnalysisView({ a, onAnswer }: { a: any; onAnswer?: (id: string, value: string) => void }) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      {a.blocks.map((b: Block, i: number) => (
        <BlockView key={i} block={b} onAnswer={onAnswer} />
      ))}
      <Sources codes={a.evidence} />
    </div>
  );
}
