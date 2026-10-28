"use client";

import Link from "next/link";
import { useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { Empty, ErrorBox, Group, Loading, MerchantMark, Money, PageHead, Row, Section } from "@/ui/kit";
import { date, day } from "@/ui/format";
import { subState } from "@/ui/labels";

const PAYABLE = new Set(["BILL", "SUPPLIER_PAYMENT", "UTILITY"]);

export default function UpcomingPage() {
  const { epoch } = useSession();
  const { data, error, reload } = useApi<any>("/upcoming", { epoch, poll: 15_000 });
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading scheduled payments…" />;
  const byDay = new Map<string, any[]>();
  for (const f of data.items) {
    const k = date(f.due_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(f);
  }
  return (
    <>
      <PageHead back="/home" title="Upcoming" sub="Scheduled payments and money expected in. Conditional items stay marked until they happen." />
      {data.subscriptionWindowTotalMinor != null ? (
        <div className="group pad" style={{ marginTop: 16 }}>
          <div className="small muted">
            Subscriptions, {day(data.window.startInclusive)} to {day(data.window.endExclusive)}
          </div>
          <div className="num" style={{ fontSize: 28, lineHeight: "34px", fontWeight: 650, marginTop: 2 }}>
            <Money minor={data.subscriptionWindowTotalMinor} />
          </div>
          <Link href="/capabilities/T2" className="btn block" style={{ marginTop: 12 }}>
            See ways to pay less
          </Link>
        </div>
      ) : null}
      {data.bulkCount ? (
        <Section>
          <Group>
            <Row href="/batch" title={`Review all ${data.bulkCount} recurring payments`} sub="Inspect each provider, then approve an exact list" />
          </Group>
        </Section>
      ) : null}
      <Section title="Scheduled" id="scheduled">
        {data.items.length ? (
          <div className="stack">
            {[...byDay.entries()].map(([d, list]) => (
              <div key={d}>
                <h3 className="caption" style={{ margin: "0 0 6px", fontSize: 13 }}>
                  {d}
                </h3>
                <Group>
                  {list.map((f: any) => (
                    <Row
                      key={f.id}
                      href={f.subscription_id ? `/home/subscriptions/${encodeURIComponent(f.subscription_id)}` : PAYABLE.has(f.kind) && f.amount_minor < 0 ? `/pay?item=${encodeURIComponent(f.id)}` : undefined}
                      mark={<MerchantMark name={f.merchant_name ?? f.label} />}
                      title={f.label}
                      sub={f.condition ? f.condition : f.kind === "TRIAL_CONVERSION" ? "Unless the trial is stopped first" : undefined}
                      end={<Money minor={f.amount_minor} sign />}
                      endSub={f.condition ? "Not certain" : undefined}
                    />
                  ))}
                </Group>
              </div>
            ))}
          </div>
        ) : (
          <Group>
            <Empty>Nothing scheduled in this context</Empty>
          </Group>
        )}
      </Section>
      {data.subscriptions.length ? (
        <Section title="Subscriptions and bills" id="subscriptions">
          <Group>
            {data.subscriptions.map((s: any) => (
              <Row
                key={s.id}
                href={`/home/subscriptions/${encodeURIComponent(s.id)}`}
                mark={<MerchantMark name={s.merchant_name} />}
                title={s.merchant_name}
                sub={`${s.plan_name}, ${subState(s.state)}`}
                end={<Money minor={s.amount_minor} />}
                endSub={s.state === "RENEWAL_OFF" && s.access_until ? `Access until ${day(s.access_until)}` : s.next_charge_at ? `Next ${day(s.next_charge_at)}` : undefined}
              />
            ))}
          </Group>
        </Section>
      ) : null}
    </>
  );
}
