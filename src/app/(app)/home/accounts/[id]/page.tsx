"use client";

import { useRouter } from "next/navigation";
import { use } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ActionStatus, Balance, Empty, ErrorBox, Group, KV, Loading, MerchantMark, Money, PageHead, Row, Section, StateLine, useAction } from "@/ui/kit";
import { NMark } from "@/ui/icons";
import { date, dayTime } from "@/ui/format";

const OPEN = new Set(["PROPOSED", "APPROVED", "EXECUTING", "PENDING", "UNKNOWN"]);

export default function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { epoch } = useSession();
  const { data, error, reload } = useApi<any>(`/accounts/${encodeURIComponent(decodeURIComponent(id))}`, { epoch });
  const { run, busy, error: actError } = useAction();
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the account…" />;
  const a = data.account;
  const card = a.card;
  const frozen = card?.status === "FROZEN";
  const openAction = data.cardActions.find((x: any) => OPEN.has(x.status));
  const draft = () =>
    run(async () => {
      const p = await api<any>(`/cards/${encodeURIComponent(a.id)}/draft`, { body: { freeze: !frozen } });
      router.push(`/review/${p.id}`);
    });
  return (
    <>
      <PageHead back="/home" title={a.name} />
      <Balance minor={a.balanceMinor} label="Available" />
      <p className="caption" style={{ margin: "4px 0 0" }}>
        {a.ibanMasked}
      </p>

      {card ? (
        <Section title="Card" id="card">
          <div className={`card-visual${frozen ? " frozen" : ""}`} role="img" aria-label={`${card.kind} card ending ${card.last4}, ${frozen ? "frozen" : "active"}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <NMark />
              <span className="small" style={{ opacity: 0.8 }}>
                {card.kind}
              </span>
            </div>
            <div className="chip-shape" />
            <div>
              <div className="pan">•••• {card.last4}</div>
              <div className="small" style={{ opacity: 0.8, marginTop: 4 }}>
                {card.holder}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <StateLine tone={frozen ? "warn" : "ok"} icon={frozen ? "stop" : "check"}>
              {frozen ? "Frozen: new card payments are declined" : "Active"}
            </StateLine>
          </div>
          {card.statusReference ? (
            <p className="caption" style={{ margin: "4px 0 0" }}>
              Last change {card.statusChangedAt ? dayTime(card.statusChangedAt) : ""}, reference {card.statusReference}
            </p>
          ) : null}
          <div className="actions">
            {openAction ? (
              <Row href={OPEN.has(openAction.status) && openAction.status !== "PROPOSED" ? `/actions/${openAction.id}` : undefined} title={openAction.title ?? "Card change"} sub={<ActionStatus status={openAction.status} merchant="NextMove bank" />} />
            ) : (
              <button type="button" className={`btn block${frozen ? " primary" : ""}`} onClick={draft} disabled={busy}>
                {frozen ? "Unfreeze card" : "Freeze card"}
              </button>
            )}
            <p className="caption" style={{ margin: 0, textAlign: "center" }}>
              {openAction?.status === "PROPOSED" ? "A card change is waiting for your approval in Agent." : "You review the exact change before it happens."}
            </p>
          </div>
          <ErrorBox error={actError} />
        </Section>
      ) : null}

      <Section title="Account details">
        <KV
          items={[
            { label: "Type", value: a.kind === "SAVINGS" ? "Savings" : a.kind === "BUSINESS_CURRENT" ? "Business current account" : "Current account" },
            { label: "IBAN", value: a.ibanMasked ?? "—" },
            { label: "Currency", value: a.currency },
          ]}
        />
      </Section>

      <Section title="Transactions">
        <Group>
          {data.transactions.length ? (
            data.transactions.map((t: any) => (
              <Row
                key={t.id}
                href={`/activity/transactions/${encodeURIComponent(t.id)}`}
                mark={<MerchantMark name={t.merchant_name} />}
                title={t.merchant_name}
                sub={t.status === "PENDING" ? "Pending card hold" : t.category}
                end={<Money minor={t.amount_minor} sign />}
                endSub={date(t.booked_at)}
              />
            ))
          ) : (
            <Empty>No transactions on this account yet</Empty>
          )}
        </Group>
      </Section>
    </>
  );
}
