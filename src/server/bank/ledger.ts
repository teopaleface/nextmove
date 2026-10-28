import type { DatabaseSync } from "node:sqlite";
import { one, all, run } from "../db/connection";
import { shortId } from "../canonical";
import { assertMinor } from "../../shared/money";

// Balanced double-entry postings. Every entry has a unique authoritative source event id, so replaying the
// same bank event (a refund credit, a transfer) can never change balances twice.

export interface PostingLine {
  accountId: string;
  amountMinor: number;
}

export class LedgerError extends Error {}

export function clearingAccountId(tenantId: string) {
  return `${tenantId}:clearing`;
}

/** Post a balanced entry. Returns the existing entry id when the source event was already posted. */
export function post(db: DatabaseSync, input: { tenantId: string; sourceEventId: string; kind: string; description: string; postedAt: string; lines: PostingLine[] }): { entryId: string; duplicate: boolean } {
  const existing = one<{ id: string }>(db, "SELECT id FROM ledger_entries WHERE tenant_id=? AND source_event_id=?", input.tenantId, input.sourceEventId);
  if (existing) return { entryId: existing.id, duplicate: true };
  let sum = 0;
  for (const l of input.lines) {
    assertMinor(l.amountMinor);
    sum += l.amountMinor;
    const acct = one<any>(db, "SELECT tenant_id FROM accounts WHERE id=?", l.accountId);
    if (!acct || acct.tenant_id !== input.tenantId) throw new LedgerError(`Account ${l.accountId} is not in tenant`);
  }
  if (sum !== 0) throw new LedgerError(`Unbalanced entry (${sum})`);
  const entryId = shortId("je");
  run(db, "INSERT INTO ledger_entries(id, tenant_id, source_event_id, kind, description, posted_at, created_at) VALUES (?,?,?,?,?,?,?)", entryId, input.tenantId, input.sourceEventId, input.kind, input.description, input.postedAt, new Date().toISOString());
  for (const l of input.lines) run(db, "INSERT INTO ledger_lines(entry_id, account_id, amount_minor, currency) VALUES (?,?,?,'RON')", entryId, l.accountId, l.amountMinor);
  return { entryId, duplicate: false };
}

export function balanceOf(db: DatabaseSync, accountId: string): number {
  const a = one<any>(db, "SELECT opening_minor FROM accounts WHERE id=?", accountId);
  const s = one<any>(db, "SELECT COALESCE(SUM(amount_minor),0) AS s FROM ledger_lines WHERE account_id=?", accountId);
  return (a?.opening_minor ?? 0) + (s?.s ?? 0);
}

export function accountsFor(db: DatabaseSync, tenantId: string, contextId: string) {
  return all<any>(db, "SELECT * FROM accounts WHERE tenant_id=? AND context_id=? AND kind != 'EXTERNAL_CLEARING' ORDER BY ordinal", tenantId, contextId).map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    ibanMasked: a.iban_masked,
    currency: a.currency,
    balanceMinor: balanceOf(db, a.id),
    card: a.card_json ? JSON.parse(a.card_json) : null,
  }));
}

/** Post a customer-facing transaction against the external clearing account. */
export function postCardOrTransfer(
  db: DatabaseSync,
  input: {
    tenantId: string;
    contextId: string;
    accountId: string;
    sourceEventId: string;
    amountMinor: number;
    merchantName: string;
    merchantId?: string | null;
    category?: string;
    reference?: string | null;
    orderRef?: string | null;
    bookedAt: string;
    note?: string | null;
    data?: Record<string, unknown>;
  },
): { transactionId: string; duplicate: boolean } {
  const { entryId, duplicate } = post(db, {
    tenantId: input.tenantId,
    sourceEventId: input.sourceEventId,
    kind: input.amountMinor < 0 ? "DEBIT" : "CREDIT",
    description: input.merchantName,
    postedAt: input.bookedAt,
    lines: [
      { accountId: input.accountId, amountMinor: input.amountMinor },
      { accountId: clearingAccountId(input.tenantId), amountMinor: -input.amountMinor },
    ],
  });
  if (duplicate) {
    const t = one<any>(db, "SELECT id FROM transactions WHERE entry_id=?", entryId);
    return { transactionId: t?.id ?? "", duplicate: true };
  }
  const id = shortId("txn");
  run(
    db,
    `INSERT INTO transactions(id, tenant_id, context_id, account_id, entry_id, status, direction, amount_minor, currency, merchant_id, merchant_name, category, reference, order_ref, booked_at, note, data_json)
     VALUES (?,?,?,?,?,'POSTED',?,?, 'RON',?,?,?,?,?,?,?,?)`,
    id,
    input.tenantId,
    input.contextId,
    input.accountId,
    entryId,
    input.amountMinor < 0 ? "DEBIT" : "CREDIT",
    input.amountMinor,
    input.merchantId ?? null,
    input.merchantName,
    input.category ?? null,
    input.reference ?? null,
    input.orderRef ?? null,
    input.bookedAt,
    input.note ?? null,
    input.data ? JSON.stringify(input.data) : null,
  );
  return { transactionId: id, duplicate: false };
}

/** Internal transfer between two of the tenant's own accounts (possibly across contexts). Funds are conserved. */
export function postInternalTransfer(
  db: DatabaseSync,
  input: { tenantId: string; sourceEventId: string; fromAccountId: string; toAccountId: string; amountMinor: number; description: string; bookedAt: string; reference: string },
) {
  if (input.amountMinor <= 0) throw new LedgerError("Transfer amount must be positive");
  const { entryId, duplicate } = post(db, {
    tenantId: input.tenantId,
    sourceEventId: input.sourceEventId,
    kind: "INTERNAL_TRANSFER",
    description: input.description,
    postedAt: input.bookedAt,
    lines: [
      { accountId: input.fromAccountId, amountMinor: -input.amountMinor },
      { accountId: input.toAccountId, amountMinor: input.amountMinor },
    ],
  });
  if (duplicate) return { entryId, duplicate };
  const from = one<any>(db, "SELECT * FROM accounts WHERE id=?", input.fromAccountId);
  const to = one<any>(db, "SELECT * FROM accounts WHERE id=?", input.toAccountId);
  for (const [acct, amount, counterparty] of [
    [from, -input.amountMinor, to.name],
    [to, input.amountMinor, from.name],
  ] as const) {
    run(
      db,
      `INSERT INTO transactions(id, tenant_id, context_id, account_id, entry_id, status, direction, amount_minor, currency, merchant_name, category, reference, booked_at, note)
       VALUES (?,?,?,?,?,'POSTED',?,?, 'RON',?,?,?,?,?)`,
      shortId("txn"),
      input.tenantId,
      acct.context_id,
      acct.id,
      entryId,
      amount < 0 ? "DEBIT" : "CREDIT",
      amount,
      counterparty,
      "Transfer",
      input.reference,
      input.bookedAt,
      input.description,
    );
  }
  return { entryId, duplicate };
}

/** Sum of all lines in the tenant, which must always be zero apart from opening balances. */
export function ledgerIntegrity(db: DatabaseSync, tenantId: string) {
  const unbalanced = all<any>(
    db,
    `SELECT e.id, SUM(l.amount_minor) s FROM ledger_entries e JOIN ledger_lines l ON l.entry_id = e.id WHERE e.tenant_id=? GROUP BY e.id HAVING s != 0`,
    tenantId,
  );
  return { balanced: unbalanced.length === 0, unbalanced };
}
