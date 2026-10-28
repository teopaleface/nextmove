"use client";

import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { Empty, ErrorBox, Group, Loading, MerchantMark, Money, Notice, PageHead, Section, StateLine, useAction } from "@/ui/kit";
import { date, money } from "@/ui/format";

export default function PayPage({ searchParams }: { searchParams: Promise<{ item?: string }> }) {
  const { item } = use(searchParams);
  const router = useRouter();
  const { epoch } = useSession();
  const { data, error, reload } = useApi<any>("/payments/payees", { epoch });
  const [picked, setPicked] = useState<string | null>(item ?? null);
  const [from, setFrom] = useState<string | null>(null);
  const { run, busy, error: actError } = useAction();
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading your bills…" />;
  const payee = data.payees.find((p: any) => p.forecastItemId === picked && !p.draftPending) ?? null;
  const fromId = from ?? data.accounts[0]?.id ?? null;
  const fromAcct = data.accounts.find((a: any) => a.id === fromId);
  const short = payee && fromAcct ? fromAcct.balanceMinor < payee.amountMinor : false;
  const draft = () =>
    run(async () => {
      const p = await api<any>("/payments/draft", { body: { forecastItemId: payee.forecastItemId, fromAccountId: fromId } });
      router.push(`/review/${p.id}`);
    });
  return (
    <>
      <PageHead back="/home" title="Pay a bill" sub="Pay a bill NextMove already knows about. New payees and free-form transfers are not part of this demo." />
      <Section title="Choose a bill" id="bills">
        {data.payees.length ? (
          <fieldset className="group" style={{ margin: 0, padding: 0, border: 0 }}>
            <legend className="sr-only">Bill to pay</legend>
            {data.payees.map((p: any) => (
              <label key={p.forecastItemId} className="row check-row" style={{ cursor: p.draftPending ? "default" : "pointer" }}>
                <input type="radio" name="payee" value={p.forecastItemId} checked={picked === p.forecastItemId} disabled={p.draftPending} onChange={() => setPicked(p.forecastItemId)} />
                <MerchantMark name={p.payee} />
                <span className="row-main">
                  <span className="row-title">{p.payee}</span>
                  <span className="row-sub">{p.draftPending ? <StateLine icon="doc">A payment is already waiting or running</StateLine> : `Due ${date(p.dueAt)}`}</span>
                </span>
                <span className="row-end">
                  <span className="row-amount">
                    <Money minor={p.amountMinor} />
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <Group>
            <Empty>No bills to pay in this context</Empty>
          </Group>
        )}
      </Section>
      {data.accounts.length ? (
        <Section title="Pay from">
          <label className="sr-only" htmlFor="from">
            Account
          </label>
          <select id="from" className="select" value={fromId ?? ""} onChange={(e) => setFrom(e.target.value)}>
            {data.accounts.map((a: any) => (
              <option key={a.id} value={a.id}>
                {a.name}, {money(a.balanceMinor)}
              </option>
            ))}
          </select>
        </Section>
      ) : null}
      {short ? (
        <div style={{ marginTop: 12 }}>
          <Notice tone="warn">This account has less than the bill amount. The bank will refuse the payment if the balance is still short when it runs.</Notice>
        </div>
      ) : null}
      <div className="actions">
        <button type="button" className="btn primary main block" onClick={draft} disabled={busy || !payee || !fromId}>
          {payee ? `Review payment of ${money(payee.amountMinor)}` : "Choose a bill"}
        </button>
        <p className="caption" style={{ margin: 0, textAlign: "center" }}>
          Nothing is paid until you approve the exact amount, payee and account.
        </p>
      </div>
      <ErrorBox error={actError} />
    </>
  );
}
