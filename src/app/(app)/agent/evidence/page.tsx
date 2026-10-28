"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ErrorBox, Group, Loading, Notice, PageHead, Row, Section, StateLine, useAction } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { dayTime, onDemoClock } from "@/ui/format";

type Kind = "SCREEN_TIME" | "STUDENT_ID" | "SUBSCRIPTION_SCREENSHOT" | "INVOICE";

const KINDS: { id: Kind; label: string }[] = [
  { id: "SCREEN_TIME", label: "Screen Time summary" },
  { id: "STUDENT_ID", label: "Student ID card" },
  { id: "SUBSCRIPTION_SCREENSHOT", label: "Subscription page" },
  { id: "INVOICE", label: "Invoice" },
];

const SAMPLES: { name: string; kind: Kind; label: string; sub: string }[] = [
  { name: "screen-time", kind: "SCREEN_TIME", label: "Screen Time, last 7 days", sub: "Match phone use to what you pay for" },
  { name: "student-id", kind: "STUDENT_ID", label: "Student ID card", sub: "Check student bundle eligibility" },
  { name: "subscription-page", kind: "SUBSCRIPTION_SCREENSHOT", label: "Streamly account page", sub: "Compare the plan with your bank record" },
  { name: "hostile-invoice", kind: "INVOICE", label: "Invoice from an unknown supplier", sub: "Contains text that tries to give instructions" },
];

const NEXT: Record<string, { href: string; label: string }> = {
  SCREEN_TIME: { href: "/capabilities/T1", label: "See what it means for your subscriptions" },
  STUDENT_ID: { href: "/capabilities/T3", label: "Use it for the student bundle" },
  SUBSCRIPTION_SCREENSHOT: { href: "/capabilities/A4", label: "Compare with the Streamly price change" },
  INVOICE: { href: "/capabilities/T1", label: "See the invoice check" },
};

const MANUAL: Record<Kind, { key: string; label: string; numeric?: "minutes" | "money" }[]> = {
  SCREEN_TIME: [
    { key: "periodLabel", label: "Period" },
    { key: "totalMinutes", label: "Total screen time (minutes)", numeric: "minutes" },
    { key: "app:Streamly", label: "Streamly (minutes)", numeric: "minutes" },
    { key: "app:StudyPlus", label: "StudyPlus (minutes)", numeric: "minutes" },
  ],
  STUDENT_ID: [
    { key: "holderName", label: "Name" },
    { key: "institution", label: "Institution" },
    { key: "studentIdNumber", label: "Student ID number" },
    { key: "validUntil", label: "Valid until" },
  ],
  SUBSCRIPTION_SCREENSHOT: [
    { key: "merchant", label: "Merchant" },
    { key: "planName", label: "Plan" },
    { key: "priceText", label: "Price" },
    { key: "renewalDateText", label: "Renews" },
  ],
  INVOICE: [
    { key: "issuer", label: "Issuer" },
    { key: "invoiceNumber", label: "Invoice number" },
    { key: "amountMinor", label: "Total (RON)", numeric: "money" },
    { key: "dueDateText", label: "Due date" },
  ],
};

const PROV: Record<string, { text: string; tone: "ok" | "warn" | "info" }> = {
  READ_FROM_IMAGE: { text: "Read from the image", tone: "ok" },
  NEEDS_CHECKING: { text: "Check this", tone: "warn" },
  YOU_ENTERED: { text: "You entered", tone: "info" },
};

/** "12.50" or "12,50" in RON to integer bani; null when empty, NaN when invalid. */
function ronToMinor(text: string): number | null {
  const t = text.trim().replace(/\s/g, "");
  if (!t) return null;
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(t);
  if (!m) return Number.NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

const shown = (key: string, v: unknown) => (v == null ? "" : key === "amountMinor" && typeof v === "number" ? (v / 100).toFixed(2) : String(v));

export default function EvidencePage() {
  const { epoch, session, toast, demoOffset } = useSession();
  const { data, error, reload } = useApi<any>("/extractions", { epoch });
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<null | "uploading" | "reading">(null);
  const [kind, setKind] = useState<Kind>("SCREEN_TIME");
  const [failed, setFailed] = useState<{ uploadId: string; kind: Kind; error: string } | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [manual, setManual] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const { run, busy, error: actError } = useAction();

  const read = async (uploadId: string, k: Kind) => {
    setPhase("reading");
    setFailed(null);
    try {
      const r = await api<any>(`/uploads/${uploadId}/extract`, { body: { kind: k } });
      await reload();
      setEdits({});
      setSelected(r.extractionId);
      if (!r.ok) setFailed({ uploadId, kind: k, error: r.error ?? "The image could not be read" });
    } finally {
      setPhase(null);
    }
  };

  const sample = (s: (typeof SAMPLES)[number]) =>
    run(async () => {
      setPhase("uploading");
      const r = await api<any>("/uploads/sample", { body: { name: s.name } });
      await read(r.upload.id, s.kind);
    }).finally(() => setPhase(null));

  const upload = () =>
    run(async () => {
      const f = fileRef.current?.files?.[0];
      if (!f) throw new Error("Choose an image first");
      if (f.size > 4 * 1024 * 1024) throw new Error("Images must be 4 MB or smaller");
      const form = new FormData();
      form.set("file", f);
      form.set("label", f.name.slice(0, 80));
      setPhase("uploading");
      const r = await api<any>("/uploads", { form });
      if (fileRef.current) fileRef.current.value = "";
      await read(r.upload.id, kind);
    }).finally(() => setPhase(null));

  const ex = data?.extractions?.find((e: any) => e.id === selected) ?? data?.extractions?.[0] ?? null;

  const confirm = () =>
    run(async () => {
      const out: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(edits)) {
        if (k === "amountMinor") {
          const m = ronToMinor(v);
          if (Number.isNaN(m)) throw new Error("Enter the total like 1870.00");
          out[k] = m;
        } else out[k] = v.trim() === "" ? null : v.trim();
      }
      await api(`/extractions/${ex.id}/confirm`, { body: { edits: out } });
      setEdits({});
      await reload();
      toast("Confirmed. Each value is saved with where it came from.");
    });

  const saveManual = () =>
    run(async () => {
      if (!failed) return;
      const values: Record<string, string | number | null> = {};
      for (const f of MANUAL[failed.kind]) {
        const v = (manual[f.key] ?? "").trim();
        if (!v) continue;
        if (f.numeric === "money") {
          const m = ronToMinor(v);
          if (m == null || Number.isNaN(m)) throw new Error(`Check ${f.label.toLowerCase()}`);
          values[f.key] = m;
        } else if (f.numeric === "minutes") {
          if (!/^\d{1,6}$/.test(v)) throw new Error(`${f.label} must be a whole number`);
          values[f.key] = Number(v);
        } else values[f.key] = v.slice(0, 200);
      }
      const r = await api<any>(`/uploads/${failed.uploadId}/manual`, { body: { kind: failed.kind, values } });
      setFailed(null);
      setManual({});
      await reload();
      setSelected(r.extractionId);
    });

  const model = session?.model;
  const modelName = model?.last?.model ?? model?.smoke?.model ?? model?.configuredModel ?? "the live model";
  const working = phase !== null;

  return (
    <>
      <PageHead back="/agent" title="Add evidence" sub="NextMove reads the image with the live model, then you check and confirm each value. Text inside an image is never treated as an instruction." />

      {working ? (
        <div className="group pad" aria-live="polite" style={{ marginTop: 8 }}>
          <StateLine icon="clock">{phase === "uploading" ? "Saving the image privately…" : `Reading the image with ${modelName}…`}</StateLine>
          <p className="caption" style={{ margin: "6px 0 0" }}>
            {phase === "reading" ? "This usually takes 10 to 40 seconds. The image goes only to the model call; it is not logged." : "Only PNG, JPEG or WebP up to 4 MB."}
          </p>
        </div>
      ) : null}

      <Section title="Try a sample" id="samples">
        <Group>
          {SAMPLES.map((s) => (
            <Row key={s.name} onClick={working || busy ? undefined : () => sample(s)} mark={<span className="mark" aria-hidden="true"><Icon.image size={20} /></span>} title={s.label} sub={s.sub} chevron={!working} />
          ))}
        </Group>
        <p className="caption" style={{ margin: "8px 0 0" }}>
          Synthetic images made for this demo. They show no real person or account.
        </p>
      </Section>

      <Section title="Or upload your own" id="upload">
        <div className="group">
          <div className="field">
            <label htmlFor="ev-kind">What is it?</label>
            <select id="ev-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ev-file">Image</label>
            <input id="ev-file" ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="input" />
            <span className="help">Use a synthetic or redacted image. Do not upload real card numbers or ID documents.</span>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn primary block" onClick={upload} disabled={working || busy}>
            Upload and read
          </button>
        </div>
      </Section>
      <ErrorBox error={actError} />

      {failed ? (
        <Section title="Enter the values yourself" id="manual">
          <Notice tone="warn" title="The image was not read">
            {failed.error}. You can type the values instead; they will be labelled as entered by you.
          </Notice>
          <div className="group" style={{ marginTop: 12 }}>
            {MANUAL[failed.kind].map((f) => (
              <div className="field" key={f.key}>
                <label htmlFor={`m-${f.key}`}>{f.label}</label>
                <input id={`m-${f.key}`} className="input" inputMode={f.numeric ? "decimal" : undefined} value={manual[f.key] ?? ""} onChange={(e) => setManual({ ...manual, [f.key]: e.target.value })} maxLength={200} autoComplete="off" />
              </div>
            ))}
          </div>
          <div className="actions">
            <button type="button" className="btn primary block" onClick={saveManual} disabled={busy}>
              Save my values
            </button>
          </div>
        </Section>
      ) : null}

      {!data ? (
        error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading your images…" />
      ) : ex ? (
        <Section title="Check and confirm" id="review">
          <div className="group">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/uploads/${encodeURIComponent(ex.uploadId)}/image`} alt={ex.label ?? "Uploaded image"} width={ex.image?.width ?? undefined} height={ex.image?.height ?? undefined} style={{ display: "block", width: "100%", height: "auto", maxHeight: 420, objectFit: "contain", background: "var(--subtle)", borderRadius: "16px 16px 0 0" }} />
            <div className="row">
              <div className="row-main">
                <div className="row-title">{ex.label}</div>
                <div className="row-sub">
                  {ex.mode === "LIVE_MODEL" ? `Read by the live model${ex.model ? ` (${ex.model})` : ""}` : "Values entered by you"}
                  {ex.fields?.durationMs ? `, ${(ex.fields.durationMs / 1000).toFixed(1)} s` : ""}
                </div>
              </div>
              {ex.status === "CONFIRMED" ? <StateLine tone="ok">Confirmed</StateLine> : ex.status === "FAILED" ? <StateLine tone="bad">Not read</StateLine> : <StateLine tone="warn">Check</StateLine>}
            </div>
          </div>

          {ex.fields?.injectedInstructions?.length ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="warn" title="Instructions inside the image were ignored">
                The image contains text addressed to an assistant: “{String(ex.fields.injectedInstructions[0]).slice(0, 200)}”. NextMove treated it as data. Nothing was paid, approved or sent.
              </Notice>
            </div>
          ) : null}

          {ex.status === "FAILED" ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="bad">{ex.fields?.error ?? "The image could not be read."}</Notice>
            </div>
          ) : (
            <>
              <div className="group" style={{ marginTop: 12 }}>
                {(ex.fields?.items ?? []).map((it: any) => {
                  const p = PROV[it.provenance] ?? PROV.YOU_ENTERED;
                  const label = it.key === "amountMinor" ? "Total (RON)" : it.key.startsWith("app:") ? `${it.key.slice(4)} (minutes)` : it.label;
                  return (
                    <div className="field" key={it.key}>
                      <label htmlFor={`f-${it.key}`}>{label}</label>
                      <input
                        id={`f-${it.key}`}
                        className="input"
                        value={edits[it.key] ?? shown(it.key, it.value)}
                        onChange={(e) => setEdits({ ...edits, [it.key]: e.target.value })}
                        inputMode={it.key === "amountMinor" || it.key === "totalMinutes" || it.key.startsWith("app:") ? "decimal" : undefined}
                        maxLength={200}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <StateLine tone={edits[it.key] !== undefined ? "info" : p.tone}>{edits[it.key] !== undefined ? "Changed by you" : p.text}</StateLine>
                    </div>
                  );
                })}
              </div>
              {ex.fields?.kind === "INVOICE" ? (
                <p className="caption" style={{ margin: "8px 0 0" }}>
                  A payee read from an image never becomes a payment. NextMove pays only bills it already knows.
                </p>
              ) : null}
              <div className="actions">
                <button type="button" className="btn primary main block" onClick={confirm} disabled={busy}>
                  {ex.status === "CONFIRMED" ? "Save changes" : "Confirm these values"}
                </button>
                {ex.status === "CONFIRMED" && NEXT[ex.fields?.kind] ? (
                  <Link className="btn block" href={NEXT[ex.fields.kind].href}>
                    {NEXT[ex.fields.kind].label}
                  </Link>
                ) : null}
              </div>
            </>
          )}
        </Section>
      ) : null}

      {data?.extractions?.length > 1 ? (
        <Section title="Earlier images" id="history">
          <Group>
            {data.extractions.map((e: any) => (
              <Row key={e.id} onClick={() => { setSelected(e.id); setEdits({}); }} title={e.label} sub={`${e.mode === "LIVE_MODEL" ? "Live model" : "Entered by you"}, ${e.status === "CONFIRMED" ? "confirmed" : e.status === "FAILED" ? "not read" : "waiting for your check"}`} endSub={dayTime(onDemoClock(e.createdAt, demoOffset))} chevron={e.id !== ex?.id} />
            ))}
          </Group>
        </Section>
      ) : null}
    </>
  );
}
