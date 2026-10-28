"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, setCsrf } from "@/ui/api";
import { NMark, Icon } from "@/ui/icons";
import { SessionProvider, useSession } from "@/ui/session";
import { Notice, useAction, ErrorBox } from "@/ui/kit";

export default function SignInPage() {
  return (
    <SessionProvider requireAuth={false}>
      <SignIn />
    </SessionProvider>
  );
}

const CUSTOMERS = [
  { id: "alex", name: "Alex", detail: "Personal banking, subscriptions, goals and travel" },
  { id: "laziz", name: "Laziz", detail: "Laziz Products (business) and his household" },
] as const;

function SignIn() {
  const router = useRouter();
  const { session } = useSession();
  const [customer, setCustomer] = useState<"alex" | "laziz">("alex");
  const [isolated, setIsolated] = useState(false);
  const { run, busy, error } = useAction();

  const go = () =>
    run(async () => {
      const r = await api<{ csrfToken: string }>("/session/demo", { body: { customer, isolated } });
      setCsrf(r.csrfToken);
      router.replace("/home");
    });

  return (
    <div className="app">
      <main className="main no-tabs" style={{ paddingTop: "calc(var(--safe-top) + 40px)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <NMark size={36} />
          <span style={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.01em" }}>NextMove</span>
          <span className="header-spacer" />
          <span className="env-label">{session?.mode === "bank-demo" ? "Demo" : "Demo Labs"}</span>
        </div>
        <h1 className="title" style={{ marginTop: 32 }}>
          Choose a demo customer
        </h1>
        <p className="lede">Synthetic accounts and fictional merchants. No real bank, card, merchant or payment is connected.</p>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Demo customer</legend>
          <div className="group">
            {CUSTOMERS.map((c) => (
              <label key={c.id} className="check-row" style={{ alignItems: "center" }}>
                <input type="radio" name="customer" value={c.id} checked={customer === c.id} onChange={() => setCustomer(c.id)} />
                <span className="avatar" style={{ width: 40, height: 40, borderRadius: 20, fontSize: 14 }} aria-hidden="true">
                  {c.id === "alex" ? "AX" : "LZ"}
                </span>
                <span className="row-main">
                  <span className="row-title" style={{ display: "block" }}>
                    {c.name}
                  </span>
                  <span className="row-sub" style={{ display: "block" }}>
                    {c.detail}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="group" style={{ marginTop: 12 }}>
          <label className="check-row">
            <input type="checkbox" checked={isolated} onChange={(e) => setIsolated(e.target.checked)} />
            <span>
              <span className="label" style={{ display: "block" }}>
                Start a separate copy
              </span>
              <span className="row-sub" style={{ display: "block" }}>
                A fresh, isolated copy of this customer. Use it to test one session against another; nothing is shared between copies.
              </span>
            </span>
          </label>
        </div>

        <div className="actions">
          <button type="button" className="btn primary main block" onClick={go} disabled={busy}>
            {busy ? "Opening…" : `Continue as ${customer === "alex" ? "Alex" : "Laziz"}`}
            {busy ? null : <Icon.send size={20} />}
          </button>
        </div>
        <ErrorBox error={error} />

        <div style={{ marginTop: 24 }}>
          <Notice tone="info" title={session?.mode === "bank-demo" ? "Bank demo" : "Labs"}>
            {session?.mode === "bank-demo"
              ? "Real operations are disabled in this demo: NextMove can read, calculate and prepare, but it will not execute changes."
              : "Labs runs fictional providers on this computer. Approved changes go only to those simulated providers and the demo ledger."}
          </Notice>
        </div>
      </main>
    </div>
  );
}
