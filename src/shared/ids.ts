// Identifier conventions shared by the bank seeder and the merchant world builder (both read the same fixtures).

export function merchantAccountId(tenantId: string, merchantId: string, local: string) {
  return `${tenantId}:${merchantId}:${local}`;
}

export function merchantContractId(tenantId: string, local: string) {
  return `${tenantId}:${local}`;
}

/** Canonical resource identity used for serialization and deduplication across actors, batches and tasks. */
export function canonicalKey(merchantId: string, subscriberAccountId: string, contractId: string) {
  return `${merchantId}|${subscriberAccountId}|${contractId}`;
}
