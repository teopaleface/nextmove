"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Icon } from "./icons";
import { ApiError, api } from "./api";
import { evidenceLabel, money, splitMoney } from "./format";

export function Money({ minor, sign, whole, className }: { minor: number | null | undefined; sign?: boolean; whole?: boolean; className?: string }) {
  const positive = sign && minor != null && minor > 0;
  return <span className={`num${positive ? " positive" : ""}${className ? ` ${className}` : ""}`}>{money(minor, { sign, whole })}</span>;
}

export function Balance({ minor, label }: { minor: number; label?: string }) {
  const { amount, ccy } = splitMoney(minor);
  return (
    <div>
      {label ? <div className="small muted">{label}</div> : null}
      <div className="balance" aria-label={`${amount} ${ccy}`}>
        {amount}
        <span className="ccy">{ccy}</span>
      </div>
    </div>
  );
}

export function Group({ children, pad, className }: { children: React.ReactNode; pad?: boolean; className?: string }) {
  return <div className={`group${pad ? " pad" : ""}${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function Row(props: { href?: string; onClick?: () => void; mark?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; end?: React.ReactNode; endSub?: React.ReactNode; chevron?: boolean; label?: string; external?: boolean }) {
  const inner = (
    <>
      {props.mark}
      <div className="row-main">
        <div className="row-title">{props.title}</div>
        {props.sub ? <div className="row-sub">{props.sub}</div> : null}
      </div>
      {props.end != null || props.endSub ? (
        <div className="row-end">
          {props.end != null ? <div className="row-amount">{props.end}</div> : null}
          {props.endSub ? <div className="row-sub">{props.endSub}</div> : null}
        </div>
      ) : null}
      {props.chevron ?? Boolean(props.href || props.onClick) ? <Icon.chevronRight size={20} className="chev" /> : null}
    </>
  );
  if (props.href) {
    if (props.external)
      return (
        <a className="row" href={props.href} aria-label={props.label}>
          {inner}
        </a>
      );
    return (
      <Link className="row" href={props.href} aria-label={props.label}>
        {inner}
      </Link>
    );
  }
  if (props.onClick)
    return (
      <button type="button" className="row" onClick={props.onClick} aria-label={props.label}>
        {inner}
      </button>
    );
  return <div className="row">{inner}</div>;
}

export function merchantInitials(name: string | null | undefined) {
  const words = String(name ?? "").replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? "";
  const caps = w.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps.slice(0, 2).join("");
  return (w[0] ?? "?").toUpperCase();
}

export function MerchantMark({ name, tone }: { name: string | null | undefined; tone?: string }) {
  const text = merchantInitials(name);
  return (
    <span className="mark" aria-hidden="true" style={tone ? { background: tone } : undefined}>
      {text || "?"}
    </span>
  );
}

export function KV({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="group" style={{ margin: 0 }}>
      {items.map((it, i) => (
        <div className="kv" key={`${it.label}-${i}`}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, action, children, id }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className="section" id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      {title || action ? (
        <div className="section-head">
          {title ? (
            <h2 className="section-title" id={id ? `${id}-title` : undefined}>
              {title}
            </h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export function StateLine({ tone = "neutral", icon, children }: { tone?: Tone; icon?: "check" | "clock" | "warning" | "doc" | "x" | "stop" | "info"; children: React.ReactNode }) {
  const name = icon ?? (tone === "ok" ? "check" : tone === "warn" ? "warning" : tone === "bad" ? "x" : tone === "info" ? "info" : "clock");
  const I = { check: Icon.checkCircle, clock: Icon.clock, warning: Icon.warning, doc: Icon.doc, x: Icon.xCircle, stop: Icon.stop, info: Icon.info }[name];
  return (
    <span className={`state ${tone}`}>
      <I size={14} />
      <span>{children}</span>
    </span>
  );
}

export function actionState(status: string, merchant?: string | null): { tone: Tone; icon: any; text: string } {
  const m = merchant ?? "the provider";
  switch (status) {
    case "PROPOSED":
      return { tone: "neutral", icon: "doc", text: "Waiting for your approval" };
    case "APPROVED":
      return { tone: "neutral", icon: "clock", text: "Approved, starting soon" };
    case "EXECUTING":
      return { tone: "neutral", icon: "clock", text: `Working with ${m}` };
    case "CONFIRMED":
      return { tone: "ok", icon: "check", text: `Confirmed by ${m}` };
    case "PENDING":
      return { tone: "neutral", icon: "clock", text: `Awaiting ${m}` };
    case "REFUSED":
      return { tone: "bad", icon: "x", text: `${m} did not accept it` };
    case "UNKNOWN":
      return { tone: "warn", icon: "warning", text: "Confirmation hasn't arrived yet" };
    case "BLOCKED":
      return { tone: "warn", icon: "warning", text: `Sign-in needed at ${m}` };
    case "TERMS_CHANGED":
      return { tone: "warn", icon: "warning", text: "Terms changed, needs another review" };
    case "REVOKED":
      return { tone: "neutral", icon: "stop", text: "Stopped before it started" };
    case "EXPIRED":
      return { tone: "neutral", icon: "stop", text: "Approval expired before it started" };
    case "NOT_STARTED":
      return { tone: "neutral", icon: "stop", text: "Not started" };
    case "OUTDATED":
      return { tone: "warn", icon: "warning", text: "Needs a fresh check" };
    case "PREPARED":
      return { tone: "neutral", icon: "doc", text: "Draft prepared, nothing sent" };
    case "NO_CHANGE":
      return { tone: "ok", icon: "check", text: "Already in place" };
    default:
      return { tone: "neutral", icon: "clock", text: status.replace(/_/g, " ").toLowerCase() };
  }
}

export function ActionStatus({ status, merchant }: { status: string; merchant?: string | null }) {
  const s = actionState(status, merchant);
  return (
    <StateLine tone={s.tone} icon={s.icon}>
      {s.text}
    </StateLine>
  );
}

export function taskState(state: string): { tone: Tone; icon: any; text: string } {
  switch (state) {
    case "QUEUED":
    case "RUNNING":
      return { tone: "neutral", icon: "clock", text: "Checking" };
    case "WAITING_USER":
      return { tone: "warn", icon: "warning", text: "Needs your input" };
    case "NEEDS_APPROVAL":
      return { tone: "neutral", icon: "doc", text: "Ready to review" };
    case "DONE":
      return { tone: "ok", icon: "check", text: "Completed" };
    case "FAILED":
      return { tone: "bad", icon: "x", text: "Could not finish" };
    case "STOPPED":
      return { tone: "neutral", icon: "stop", text: "Stopped" };
    default:
      return { tone: "neutral", icon: "clock", text: state.replace(/_/g, " ").toLowerCase() };
  }
}

export function TaskStatus({ state }: { state: string }) {
  const s = taskState(state);
  return (
    <StateLine tone={s.tone} icon={s.icon}>
      {s.text}
    </StateLine>
  );
}

export function Notice({ tone = "info", children, title }: { tone?: "info" | "warn" | "bad"; title?: string; children: React.ReactNode }) {
  const I = tone === "info" ? Icon.info : tone === "warn" ? Icon.warning : Icon.xCircle;
  return (
    <div className={`notice ${tone}`} role={tone === "bad" ? "alert" : undefined}>
      <I size={18} />
      <div>
        {title ? <div className="label">{title}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function Empty({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div>{children}</div>
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <Notice tone="bad" title={(error as ApiError).status === 404 ? "Not found" : "Something needs attention"}>
        {error.message}
        {onRetry ? (
          <div>
            <button type="button" className="btn text" style={{ paddingLeft: 0 }} onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : null}
      </Notice>
    </div>
  );
}

export function Skeleton({ h = 72, style }: { h?: number; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, ...style }} aria-hidden="true" />;
}

export function Loading({ label = "Updating your accounts…" }: { label?: string }) {
  return (
    <div className="stack" style={{ marginTop: 16 }} aria-busy="true">
      <span className="sr-only">{label}</span>
      <Skeleton h={96} />
      <Skeleton h={160} />
      <Skeleton h={120} />
    </div>
  );
}

export function PageHead({ title, sub, back }: { title: React.ReactNode; sub?: React.ReactNode; back?: string | true }) {
  const router = useRouter();
  return (
    <div>
      {back ? (
        <div className="page-head">
          {back === true ? (
            <button type="button" className="icon-btn" onClick={() => router.back()} aria-label="Back">
              <Icon.chevronLeft />
            </button>
          ) : (
            <Link className="icon-btn" href={back} aria-label="Back">
              <Icon.chevronLeft />
            </Link>
          )}
        </div>
      ) : null}
      <h1 className="title">{title}</h1>
      {sub ? <p className="lede">{sub}</p> : null}
    </div>
  );
}

export function Sources({ codes, prefix = "Sources" }: { codes: (string | null | undefined)[]; prefix?: string }) {
  const list = [...new Set(codes.filter(Boolean) as string[])];
  if (!list.length) return null;
  return (
    <p className="caption" style={{ margin: "8px 0 0" }}>
      {prefix}: {list.map(evidenceLabel).join(", ")}
    </p>
  );
}

/** Wraps a mutation with busy and error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e: any) {
      setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e?.message ?? e)));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, setError };
}

export { api };
