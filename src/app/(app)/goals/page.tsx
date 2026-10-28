"use client";

import { useApi } from "@/ui/api";
import { useSession } from "@/ui/session";
import { Empty, ErrorBox, Group, Loading, Row, Section } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { date } from "@/ui/format";

const GOAL_SUB: Record<string, string> = {
  HOME: "When the home becomes affordable, with and without big purchases",
  PURCHASE: "Price plus accessories, protection and service",
  TRIP: "Data, card fees and currency for the trip",
  WISHLIST: "Use store credit before it expires",
  BUSINESS_ORDER: "Cash, stock and timing for a large order",
  NEW_BUSINESS: "Opening cash, reserve and break-even",
};
const SIM_GROUPS = new Set(["Goals", "Purchases", "Travel", "Business"]);

export default function GoalsPage() {
  const { epoch, session } = useSession();
  const { data, error, reload } = useApi<any>("/goals", { epoch });
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading your goals…" />;
  const business = session?.context?.kind === "BUSINESS";
  const goalCaps = new Set(["O1", "A10", "A14", "A12", "O5"]);
  const sims = data.capabilities.filter((c: any) => c.inThisContext && SIM_GROUPS.has(c.group) && !goalCaps.has(c.id));
  return (
    <>
      <h1 className="title">Goals</h1>
      <p className="lede">{business ? "Plans for the business, worked out from its own accounts and records." : "Plans worked out from your own balances and bills. Change any assumption and the dates move."}</p>
      <Section title={business ? "Business plans" : "Your goals"} id="goals">
        <Group>
          {data.goals.length ? (
            data.goals.map((g: any) => (
              <Row key={g.id} href={`/goals/${encodeURIComponent(g.id)}`} mark={<span className="mark" aria-hidden="true">{g.kind === "TRIP" ? <Icon.globe size={20} /> : g.kind === "HOME" ? <Icon.home size={20} /> : g.kind === "NEW_BUSINESS" || g.kind === "BUSINESS_ORDER" ? <Icon.briefcase size={20} /> : <Icon.goals size={20} />}</span>} title={g.name} sub={GOAL_SUB[g.kind] ?? "Open the plan"} />
            ))
          ) : (
            <Empty>No goals in this context yet</Empty>
          )}
        </Group>
      </Section>
      {sims.length ? (
        <Section title="Other calculators" id="calculators">
          <Group>
            {sims.map((c: any) => (
              <Row key={c.id} href={`/capabilities/${c.id}`} title={c.title} sub={c.short} />
            ))}
          </Group>
        </Section>
      ) : null}
      <Section title="Saved decisions" id="saved">
        <Group>
          {data.saved.length ? (
            data.saved.map((x: any) => <Row key={x.id} href={`/capabilities/${x.kind}`} title={x.choice ?? "Saved plan"} sub={`Saved ${date(x.created_at)}, input revision ${x.input_revision}`} />)
          ) : (
            <Empty>Nothing saved yet. Save a plan from a goal to keep the numbers you decided on.</Empty>
          )}
        </Group>
      </Section>
    </>
  );
}
