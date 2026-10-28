import { all } from "../../db/connection";
import { type Analysis, type Block, type CapEnv, type CapabilityDef, type Candidate, display, fmtDate, fmtWhen, spec } from "../../capabilities/core";
import type { ExtensionModule } from "../types";
import { iso, stopReceipts } from "../cancellation-guarantee/stop-receipts";
import { getCertificate, issueOp, STATEMENT, sweep, VALIDITY_DAYS, verifyPresented } from "../certificate/service";
import { effectiveDateOf, present } from "../../../../extensions/src/cancellation-certificate/index.ts";
import { endingInForce } from "../../../../extensions/src/shared/receipts.ts";

// E8 Cancellation certificate: after a provider confirms a stop and NextMove reads its state back, the customer can
// get a signed certificate (Ed25519, selective disclosure) to show a provider, a collections agency or anyone else.
// It is NextMove's statement of what the bank observed, never the provider's own document.

const KEY = "certificate";

async function analyzeE8(env: CapEnv): Promise<Analysis> {
  sweep(env.db, env.tenantId);
  const view = stopReceipts(env.db, env.tenantId, env.contextId);
  const now = iso(env.now);
  const certs = all<any>(env.db, "SELECT * FROM ext_certificate WHERE tenant_id=? AND context_id=? ORDER BY issued_at DESC", env.tenantId, env.contextId);
  const blocks: Block[] = [];
  const candidates: Candidate[] = [];

  if (!view.stops.length) {
    blocks.push({ kind: "note", tone: "info", text: "No confirmed stop yet in this context, so there is nothing to certify. A certificate can be issued once a provider confirms a stop and NextMove reads its state back, for example after stopping DashEats Plus (A15) or PulseGym (A17)." });
  }

  for (const s of view.stops) {
    const ending = endingInForce(view.receipts, view.scope, s.sub.id, now);
    if (ending?.receiptId !== s.receipt.receiptId) continue;
    const live = certs.find((c) => c.receipt_id === s.receipt.receiptId && !c.revoked_at);
    if (live) continue;
    const strong = s.receipt.verification === "INDEPENDENT_READ_BACK";
    candidates.push({
      key: `certificate-${s.sub.id}`,
      defaultSelected: true,
      available: strong,
      ...(strong ? {} : { unavailableReason: "This stop was not read back from the provider, so it cannot be certified" }),
      spec: spec({
        operation: "EXT_ISSUE_CERTIFICATE",
        route: "BANK_INTERNAL",
        capability: "E8",
        subjectRef: s.sub.id,
        merchantId: s.sub.merchant_id,
        merchantName: s.sub.merchant_name,
        canonicalKey: `ext-cert:${s.bankReceiptId}`,
        params: { subscriptionId: s.sub.id, receiptId: s.receipt.receiptId, bankReceiptId: s.bankReceiptId, validityDays: VALIDITY_DAYS },
        display: display(
          `Issue a cancellation certificate for ${s.sub.merchant_name}`,
          `A signed certificate that ${s.sub.merchant_name} confirmed the stop (ref ${s.receipt.receiptId}) and that NextMove read it back on ${fmtWhen(s.receipt.confirmedAt)}. You choose which details to show each time you share it.`,
          [
            { label: "Provider", value: s.sub.merchant_name },
            { label: "Stop reference", value: s.receipt.receiptId },
            { label: "Effective", value: fmtDate(effectiveDateOf(s.receipt)) },
            { label: "Valid for", value: `${VALIDITY_DAYS} days; withdrawn automatically if the provider turns renewal back on` },
            { label: "Never included", value: "Amounts, your name, account or card numbers" },
          ],
          STATEMENT,
          "Issue certificate",
        ),
      }),
    });
  }

  if (certs.length) {
    blocks.push({
      kind: "table",
      title: "Your certificates",
      columns: ["Provider", "Stop reference", "Issued", "Valid until", "Status"],
      rows: certs.map((c) => ({
        cells: [c.merchant_name, c.receipt_id, fmtWhen(c.issued_at), fmtDate(c.expires_at), c.revoked_at ? `Withdrawn ${fmtDate(c.revoked_at)}` : Date.parse(c.expires_at) <= env.nowMs ? "Expired" : "Valid"],
        tone: c.revoked_at ? "warn" : "good",
      })),
      note: STATEMENT,
    });
    const current = certs.find((c) => !c.revoked_at);
    if (current) {
      blocks.push({
        kind: "facts",
        title: `${current.merchant_name} certificate`,
        items: [
          { label: "Certificate ID", value: current.cert_id, provenance: "Signed by NextMove (Ed25519)" },
          { label: "Download", value: `/api/ext/${KEY}/certificates/${current.cert_id}`, provenance: "Owner only" },
          { label: "Share only the date", value: `/api/ext/${KEY}/certificates/${current.cert_id}?reveal=effectiveDate`, provenance: "Selective disclosure" },
        ],
      });
    }
  }

  const current = certs.find((c) => !c.revoked_at);
  const labs: NonNullable<Analysis["labs"]> = current
    ? [
        { action: "verify-full", label: "Check the certificate as a provider would", endpoint: `/ext/${KEY}/verify`, body: { certificate: current.holder_copy } },
        { action: "verify-date", label: "Check a copy showing only the effective date", endpoint: `/ext/${KEY}/verify`, body: { certificate: present(current.holder_copy, ["effectiveDate"]) } },
      ]
    : [];

  return {
    capability: "E8",
    title: "Cancellation certificate",
    contextId: env.contextId,
    headline: candidates.some((c) => c.available) ? `${candidates.filter((c) => c.available).length} stop(s) can be certified` : certs.some((c) => !c.revoked_at) ? `${certs.filter((c) => !c.revoked_at).length} valid certificate(s)` : "Nothing to certify yet",
    summary: "Proof you can show anyone that a subscription was stopped: a signed certificate any holder of NextMove's public key can check without calling the bank. It is NextMove's statement of what the bank observed, not the provider's.",
    evidence: ["BANK_RECORD", "DETERMINISTIC_CALCULATION"],
    blocks,
    inputs: [],
    candidates,
    numbers: { confirmedStops: view.stops.length, certifiable: candidates.filter((c) => c.available).length, valid: certs.filter((c) => !c.revoked_at).length, withdrawn: certs.filter((c) => c.revoked_at).length },
    links: view.stops.length ? [] : [{ label: "Stop DashEats Plus (A15)", href: "/capabilities/A15" }, { label: "Stop PulseGym (A17)", href: "/capabilities/A17" }],
    labs,
  };
}

export const E8: CapabilityDef = {
  id: "E8",
  title: "Cancellation certificate",
  short: "Signed proof that a subscription was stopped",
  group: "Evidence",
  customer: "alex",
  contextKind: "PERSONAL",
  keywords: ["certificate", "proof of cancellation", "proof i cancelled", "cancellation proof", "collections", "they say i didn't cancel"],
  analyze: analyzeE8,
};

export const certificate: ExtensionModule = {
  key: KEY,
  capabilities: [E8],
  operations: { EXT_ISSUE_CERTIFICATE: issueOp },
  routes: [
    { method: "GET", path: "/certificates/:id", fn: ({ db, session, params, url }) => getCertificate(db, session, params.id ?? "", url) },
    { method: "POST", path: "/verify", fn: async ({ db, session, body }) => verifyPresented(db, session, await body()) },
  ],
};
