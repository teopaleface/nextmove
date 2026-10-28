// Fails fast with a clear message when the local stack is not running.
export default async function globalSetup() {
  const base = process.env.NEXTMOVE_BANK_URL ?? "http://127.0.0.1:3210";
  const r = await fetch(`${base}/api/health`).catch(() => null);
  if (!r || !r.ok) throw new Error(`NextMove is not running at ${base}. Start it with \`npm run demo\` (or \`npm run dev\`) first.`);
  const h: any = await r.json();
  if (!h.ok || !h.merchant?.ok || !h.worker?.live) throw new Error(`NextMove is not ready: ${JSON.stringify({ merchant: h.merchant?.ok, worker: h.worker?.live })}`);
}
