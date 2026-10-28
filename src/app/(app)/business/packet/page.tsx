"use client";

import { api, useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { ErrorBox, Loading, Notice, PageHead, Section, StateLine, useAction } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { dayTime, onDemoClock } from "@/ui/format";

/** Minimal, escaped rendering of the packet's markdown: headings, bullets and paragraphs only. */
function PacketText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      const items = list;
      blocks.push(
        <ul key={`l${blocks.length}`} style={{ margin: "0 0 12px", paddingLeft: 18 }}>
          {items.map((x, i) => (
            <li key={i} style={{ marginBottom: 4 }}>
              {x}
            </li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*[-*] /.test(line)) {
      list.push(line.replace(/^\s*[-*] /, "").replace(/\*\*/g, ""));
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) blocks.push(h[1].length === 1 ? <h2 key={blocks.length} className="section-title" style={{ margin: "4px 0 8px" }}>{h[2]}</h2> : <h3 key={blocks.length} className="label" style={{ margin: "12px 0 6px" }}>{h[2]}</h3>);
    else blocks.push(<p key={blocks.length} style={{ margin: "0 0 10px" }}>{line.replace(/\*\*/g, "")}</p>);
  }
  flush();
  return <div className="small" style={{ color: "var(--ink)" }}>{blocks}</div>;
}

export default function PacketPage() {
  const { epoch, session, demoOffset } = useSession();
  const business = session?.context?.kind === "BUSINESS";
  const { data, error, reload } = useApi<any>(business ? "/business/packet" : null, { epoch });
  const { run, busy, error: actError } = useAction();
  const prepare = () =>
    run(async () => {
      await api("/business/packet", { body: {} });
      await reload();
    });
  const download = () => {
    const blob = new Blob([data.packet.markdown], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "funding-discussion-packet.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (session && !business)
    return (
      <>
        <PageHead back title="Funding packet" />
        <Notice tone="info">The funding packet belongs to the business context. Switch to it with the context switcher at the top of the screen.</Notice>
      </>
    );
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading the packet…" />;
  const p = data.packet;
  return (
    <>
      <PageHead back title="Funding packet" sub="A summary of the order, cash position and the two fictional funding offers, for a conversation with a lender. NextMove prepares it; it never sends it or applies for credit." />
      {p ? (
        <>
          <div className="group pad" style={{ marginTop: 8 }}>
            <StateLine icon="doc">Prepared, not sent</StateLine>
            <p className="caption" style={{ margin: "4px 0 12px" }}>
              Revision {p.revision}, prepared {dayTime(onDemoClock(p.updatedAt, demoOffset))}
            </p>
            <PacketText text={p.markdown} />
          </div>
          <div className="actions">
            <button type="button" className="btn primary block" onClick={download}>
              <Icon.download size={18} /> Download as text
            </button>
            <button type="button" className="btn block" onClick={prepare} disabled={busy}>
              Prepare again with current numbers
            </button>
          </div>
        </>
      ) : (
        <Section>
          <div className="actions" style={{ marginTop: 0 }}>
            <button type="button" className="btn primary main block" onClick={prepare} disabled={busy}>
              Prepare the packet
            </button>
            <p className="caption" style={{ margin: 0, textAlign: "center" }}>
              Uses only this business's own records. Nothing is shared.
            </p>
          </div>
        </Section>
      )}
      <ErrorBox error={actError} />
    </>
  );
}
