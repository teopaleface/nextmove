import { bankDb } from "../src/server/db/connection";
import { seedTenant, tenantExists } from "../src/server/scenarios/seed";
import { loadLocalEnv } from "./lib/procs";

// Seeds the two demo customers (bank side and merchant side) when they are missing. Requires the merchant to be up.
// `--force` re-seeds them from the fixtures.

loadLocalEnv();
const force = process.argv.includes("--force");
const db = bankDb();
for (const customer of ["alex", "laziz"] as const) {
  if (!force && tenantExists(db, customer)) {
    console.log(`[seed] ${customer}: present`);
    continue;
  }
  const r = await seedTenant(db, customer, customer);
  console.log(`[seed] ${customer}: seeded ${JSON.stringify(r)}`);
}
