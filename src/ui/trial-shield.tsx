"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { Icon } from "./icons";
import { ErrorBox, Group, MerchantMark, Row, Section, StateLine, useAction } from "./kit";
import { dayTime, money } from "./format";

// Trial Shield (T4) surfaces. The server builds both decisions; a button only names a candidate key and opens the
// exact review, so the customer still approves the precise action before the bank does anything.

interface Candidate {
  key: string;
  available: boolean;
  spec: { operation: string; merchantName: string; params: { holdTransactionId: string; amountMinor: number; advertisedMinor: number | null; heldAt: string; expiresAt: string } };
}

/** The held charge and its two choices: block the merchant (primary) or allow this exact payment. */
export function ShieldDecision({ candidates }: { candidates: Candidate[] }) {
  const router = useRouter();
  const { run, busy, error } = useAction();
  const holds = new Map<string, { block?: Candidate; allow?: Candidate }>();
  for (const c of candidates) {
    const id = c.spec.params?.holdTransactionId;
    if (!id) continue;
    const h = holds.get(id) ?? {};
    if (c.spec.operation === "MERCHANT_BLOCK") h.block = c;
    if (c.spec.operation === "HOLD_ALLOW") h.allow = c;
    holds.set(id, h);
  }
  const choose = (key: string) =>
    run(async () => {
      const p = await api<any>("/capabilities/T4/propose", { body: { keys: [key], inputs: {} } });
      router.push(`/review/${p.id}`);
    });
  if (!holds.size) return null;
  return (
    <Section title="What should we do?" id="decide">
      <div className="stack" style={{ gap: 24 }}>
        {[...holds.entries()].map(([id, h]) => {
          const c = (h.block ?? h.allow)!;
          const p = c.spec.params;
          const name = c.spec.merchantName;
          const differs = p.advertisedMinor != null && p.advertisedMinor !== p.amountMinor;
          return (
            <div key={id}>
              <Group>
                <Row mark={<MerchantMark name={name} />} title={name} sub={`Tried ${dayTime(p.heldAt)}`} end={<span className="num" style={{ color: "var(--muted)" }}>{money(-p.amountMinor, { sign: true })}</span>} endSub="On hold" />
                <dl style={{ margin: 0, borderTop: "1px solid var(--border)" }}>
                <div className="kv">
                  <dt>Advertised price</dt>
                  <dd>
                    {p.advertisedMinor == null ? "Not known" : `${money(p.advertisedMinor)} / month`}
                    {differs ? (
                      <div>
                        <StateLine tone="warn">Different from what they asked</StateLine>
                      </div>
                    ) : null}
                  </dd>
                </div>
                <div className="kv">
                  <dt>Decide by</dt>
                  <dd>{dayTime(p.expiresAt)}</dd>
                </div>
                </dl>
              </Group>
              <p className="caption" style={{ margin: "8px 0 0" }}>
                No decision by then means we decline it. Nothing leaves your account either way until you approve.
              </p>
              <div className="actions">
                {h.block ? (
                  <button type="button" className="btn primary block main" onClick={() => choose(h.block!.key)} disabled={busy || !h.block.available}>
                    <Icon.shield size={20} />
                    Block {name}
                  </button>
                ) : null}
                {h.allow ? (
                  <button type="button" className="btn block" onClick={() => choose(h.allow!.key)} disabled={busy || !h.allow.available}>
                    Allow the {money(p.amountMinor)} payment
                  </button>
                ) : null}
                <p className="caption" style={{ margin: 0, textAlign: "center" }}>
                  {busy ? "Preparing the review…" : "Each choice opens an exact review first."}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <ErrorBox error={error} />
    </Section>
  );
}

/** Home alert for held charges. Held payments come before suggestions: they need a decision with a deadline. */
export function ShieldAlert({ findings }: { findings: any[] }) {
  const held = findings.filter((f) => f.kind === "TRIAL_SHIELD_HOLD");
  if (!held.length) return null;
  return (
    <Section title="Needs your decision" id="held">
      <Group>
        {held.map((f) => (
          <Row
            key={f.id}
            href="/capabilities/T4"
            mark={
              <span className="mark" aria-hidden="true" style={{ color: "var(--danger)" }}>
                <Icon.shield size={20} />
              </span>
            }
            title={f.title}
            sub={<StateLine tone="warn" icon="stop">Held. Nothing has left your account</StateLine>}
            label={`${f.title}. Held, nothing has left your account. Decide what to do.`}
          />
        ))}
      </Group>
    </Section>
  );
}

/** Transaction detail line for a Trial Shield hold or a released card check. */
export function ShieldTransactionState({ t }: { t: any }) {
  if (t.status === "RELEASED")
    return <StateLine tone="neutral" icon="info">{t.data?.authType === "CARD_CHECK" ? "Card check, released. No money moved" : "Released, nothing was charged"}</StateLine>;
  if (t.status === "PENDING" && t.data?.trialShield)
    return (
      <>
        <StateLine tone="warn" icon="stop">Held by Trial Shield, not taken from your account</StateLine>
        <div style={{ marginTop: 12 }}>
          <Link href="/capabilities/T4" className="btn primary block">
            Decide what to do
          </Link>
        </div>
      </>
    );
  return null;
}
