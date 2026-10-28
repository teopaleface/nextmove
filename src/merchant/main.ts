import { merchantDb } from "./db";
import { createMerchantServer, deliverEvents, tickAll } from "./server";
import { config, localSecrets, repoRoot } from "../server/config";

// Simulated merchant origin: a separate loopback process with its own database.

const db = merchantDb(config.merchantDbPath);
const secrets = localSecrets();
const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
const server = createMerchantServer({
  db,
  root: repoRoot(),
  adminToken: secrets.merchantAdminToken,
  partnerKey: secrets.partnerHmacKey,
  bankBaseUrl: config.bankBaseUrl,
  log,
});

server.listen(config.merchantPort, "127.0.0.1", () => log(`[merchant] listening on http://127.0.0.1:${config.merchantPort}`));

let stopping = false;
async function loop() {
  while (!stopping) {
    try {
      tickAll(db);
      await deliverEvents(db, config.bankBaseUrl, secrets.partnerHmacKey, log);
    } catch (e: any) {
      log(`[merchant] loop error ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}
void loop();

function shutdown() {
  stopping = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
