"use client";

import Link from "next/link";
import { useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { Icon, AgentSig } from "@/ui/icons";
import { Balance, ErrorBox, Group, Loading, MerchantMark, Money, Row, Section, TaskStatus, Empty } from "@/ui/kit";
import { date, day, dayTime, short } from "@/ui/format";
import { ShieldAlert } from "@/ui/trial-shield";

export default function HomePage() {
  const { epoch, session } = useSession();
  const { data, error, reload } = useApi<any>("/home", { epoch, poll: 15_000 });
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  const business = data.context.kind === "BUSINESS";
  const cardAccount = data.accounts.find((a: any) => a.card) ?? data.accounts[0];
  return (
    <>
      <h1 className="sr-only">{business ? `${data.context.name} home` : "Home"}</h1>
      <section aria-label="Funds" style={{ marginTop: 8 }}>
        <Balance minor={data.totalMinor} label={business ? "Business funds" : "Total liquid funds"} />
        <p className="caption" style={{ margin: "4px 0 0" }}>
          {business && data.context.reserve_floor_minor ? <>Reserve floor {short(data.context.reserve_floor_minor)}. </> : null}
          Demo clock {dayTime(data.demoNow)}
        </p>
        <div className="accounts">
          {data.accounts.map((a: any) => (
            <Link key={a.id} href={`/home/accounts/${encodeURIComponent(a.id)}`} className="account-tile" aria-label={`${a.name}, ${short(a.balanceMinor)}`}>
              <div className="label">{a.name}</div>
              <div className="caption">{a.ibanMasked}</div>
              <div className="amt">
                <Money minor={a.balanceMinor} />
              </div>
            </Link>
          ))}
        </div>
      </section>

      <nav className="quick" aria-label="Everyday actions">
        <Link href="/pay" className="primary">
          <span className="q-icon">
            <Icon.send />
          </span>
          Pay
        </Link>
        <Link href={cardAccount ? `/home/accounts/${encodeURIComponent(cardAccount.id)}` : "/home"}>
          <span className="q-icon">
            <Icon.card />
          </span>
          Cards
        </Link>
        <Link href="/home/upcoming">
          <span className="q-icon">
            <Icon.calendar />
          </span>
          Upcoming
        </Link>
        <Link href={business ? "/business/packet" : "/agent/evidence"}>
          <span className="q-icon">{business ? <Icon.doc /> : <Icon.image />}</span>
          {business ? "Funding" : "Evidence"}
        </Link>
      </nav>

      {!business && session?.customer === "alex" ? (
        <Section title="Financial Airbag" id="financial-airbag">
          <Group>
            <Row href="/capabilities/O9" title="Review optional spending" sub="Choose services to pause or stop renewing. Opening this review changes nothing." mark={<span className="mark" aria-hidden="true"><Icon.pause size={20} /></span>} />
          </Group>
        </Section>
      ) : null}

      <ShieldAlert findings={data.findings} />

      {data.opportunity ? (
        <section className="section" aria-label="Suggested by NextMove">
          <div className="opportunity">
            <AgentSig />
            <h2>{data.opportunity.title}</h2>
            <p>{data.opportunity.body}</p>
            <Link href={data.opportunity.href} className="btn primary block">
              {data.opportunity.cta}
            </Link>
          </div>
        </section>
      ) : null}

      {data.findings.some((f: any) => f.kind !== "TRIAL_SHIELD_HOLD") ? (
        <Section title="Worth a look" id="findings">
          <Group>
            {data.findings.filter((f: any) => f.kind !== "TRIAL_SHIELD_HOLD").map((f: any) => (
              <Row key={f.id} href={/^[OTA]\d{1,2}$/.test(f.task_kind ?? "") ? `/capabilities/${f.task_kind}` : "/agent/monitoring"} mark={<span className="mark" aria-hidden="true"><Icon.bell size={20} /></span>} title={f.title} sub={f.body} />
            ))}
          </Group>
        </Section>
      ) : null}

      <Section title="Coming up" id="upcoming" action={<Link href="/home/upcoming">See all</Link>}>
        <Group>
          {data.upcoming.windowTotalMinor != null ? (
            <Row
              href="/home/upcoming"
              title="Subscriptions, next 30 days"
              sub={`${day(data.upcoming.window.startInclusive)} to ${day(data.upcoming.window.endExclusive)}`}
              end={<Money minor={data.upcoming.windowTotalMinor} />}
            />
          ) : null}
          {data.upcoming.items.slice(0, 5).map((f: any) => (
            <Row
              key={f.id}
              href={f.subscription_id ? `/home/subscriptions/${encodeURIComponent(f.subscription_id)}` : "/home/upcoming"}
              mark={<MerchantMark name={f.merchant_name ?? f.label} />}
              title={f.label}
              sub={date(f.due_at)}
              end={<Money minor={f.amount_minor} sign />}
            />
          ))}
          {!data.upcoming.items.length ? <Empty>No scheduled payments in the next 30 days</Empty> : null}
        </Group>
      </Section>

      {data.tasks.length ? (
        <Section title="Agent tasks" id="tasks" action={<Link href="/agent">Open Agent</Link>}>
          <Group>
            {data.tasks.map((t: any) => (
              <Row key={t.id} href={`/agent/tasks/${t.id}`} title={t.title} sub={<TaskStatus state={t.state} />} />
            ))}
          </Group>
        </Section>
      ) : null}

      {session?.isolated ? (
        <p className="caption" style={{ marginTop: 24 }}>
          Separate copy {session.tenantRef}. Data here is isolated from other demo sessions.
        </p>
      ) : null}
    </>
  );
}
