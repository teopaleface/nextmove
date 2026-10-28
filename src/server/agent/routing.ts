// Request text → capability, for the deterministic planner (and find_capability on the live path). Plain keyword
// scoring, but on whole words: "rent" no longer matches "current", "gym" not "gymnastics", "paid" not "repaid".
// A clause the customer negates ("don't cancel anything") does not count towards a capability, and a request that
// only negates or asks "what would happen if" is answered without preparing anything.

export interface Routable {
  id: string;
  keywords: string[];
}

/** Lower case, no diacritics (Romanian ă â î ș ț), straight apostrophes, single spaces. */
export function normalizeRequest(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = new Map<string, RegExp>();

/**
 * A keyword as a whole-word pattern that still takes the usual endings: trial → trials, cancel → cancelled /
 * cancellation, stop → stopped, pause → paused / pausing, currency → currencies. Apostrophes and hyphens are optional.
 */
export function keywordPattern(keyword: string): RegExp {
  const hit = patterns.get(keyword);
  if (hit) return hit;
  const k = normalizeRequest(keyword);
  const last = k.at(-1) ?? "";
  const body = (s: string) => esc(s).replace(/'/g, "'?").replace(/[- ]/g, "[- ]?");
  let p: string;
  if (!/[a-z]/.test(last)) p = body(k);
  else if (last === "e") p = `${body(k.slice(0, -1))}(?:e|es|ed|ing)`;
  else if (last === "y" && k.length > 3) p = `${body(k.slice(0, -1))}(?:y|ies|ied|ying)`;
  else p = `${body(k)}(?:${esc(last)})?(?:s|es|ed|ing|ation|ations)?`;
  const re = new RegExp(`(?<![a-z])${p}(?![a-z])`);
  patterns.set(keyword, re);
  return re;
}

export const hasKeyword = (normalized: string, keyword: string) => keywordPattern(keyword).test(normalized);

// Verbs that say "do this" in a capability's own vocabulary but name no subject. Alone they still route (to the
// trial capability), but any subject the customer names (gym, Streamly, storage) outweighs them.
const GENERIC = new Set(["cancel", "stop", "anuleaza", "opreste"]);

// "Don't / do not / never / no need to / rather not" followed within a few words by an action that changes something.
// Past tense ("I didn't cancel", "they say I didn't cancel") is a fact, not an instruction, and is left alone.
const ACTION = "cancel\\w*|stop\\w*|pause\\w*|terminate\\w*|close\\w*|unsubscrib\\w*|downgrad\\w*|switch\\w*|change\\w*|touch\\w*|move\\w*|transfer\\w*|block\\w*|hold\\w*|freez\\w*|remove\\w*|prepare\\w*|do|make|act";
const NEGATED = new RegExp(
  `(?:\\b(?:don'?t|do not|never|no need to|rather not|nu)\\s+(?:(?!(?:so|and|then|but|or)\\b)[\\w']+\\s+){0,3}?(?:${ACTION}|anul\\w*|opri\\w*|schimb\\w*|muta\\w*|bloca\\w*|face\\w*|nimic)\\b)[^,.;!?]*?(?=[,.;!?]|\\s(?:but|just|only|instead|doar|dar)\\b|$)`,
  "g",
);
const HYPOTHETICAL = /\b(?:what (?:would|will|could) happen if|what happens if|hypothetically|just curious|what if i (?:cancel|stop|pause|downgrad|switch|close|end))/;

/** The request with every negated action clause removed. */
export function withoutNegated(normalized: string): string {
  return normalized.replace(NEGATED, " ").replace(/\s+/g, " ").trim();
}

// Asking for balances or accounts: the overview answers that better than any capability a stray word points to.
const OVERVIEW = ["balance", "balances", "my accounts", "account balance", "how much money do i have", "how much do i have", "cat am in cont", "cati bani am", "soldul"];

export function scoreText(normalized: string, cap: Routable): number {
  let s = 0;
  for (const k of cap.keywords) if (hasKeyword(normalized, k)) s += GENERIC.has(k) ? 1 : normalizeRequest(k).length;
  if (new RegExp(`(?<![a-z0-9])${esc(cap.id.toLowerCase())} `).test(normalized)) s += 20;
  return s;
}

export interface Route<C extends Routable> {
  matches: { c: C; score: number }[];
  /** Score of a balance/accounts question; the overview wins when it is at least the best capability's score. */
  overview: number;
  /** The only capability words were inside a negated clause ("don't cancel my trial"): show, never prepare. */
  declined: boolean;
  /** "What would happen if I cancelled …": show, never prepare. */
  hypothetical: boolean;
}

export function routeRequest<C extends Routable>(text: string, caps: C[]): Route<C> {
  const full = normalizeRequest(text);
  const kept = withoutNegated(full);
  const rank = (t: string) => caps.map((c) => ({ c, score: scoreText(t, c) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const overview = OVERVIEW.filter((k) => hasKeyword(kept, k)).reduce((s, k) => s + k.length, 0);
  let matches = rank(kept);
  let declined = false;
  if (!matches.length && kept !== full && !overview) {
    matches = rank(full);
    declined = matches.length > 0;
  }
  return { matches, overview, declined, hypothetical: HYPOTHETICAL.test(full) };
}

/** A short opener for thanks, greetings and "who are you", in front of the overview; null for anything else. */
export function smallTalk(text: string): string | null {
  const t = normalizeRequest(text);
  if (/\b(thanks?|thank you|thx|multumesc|mersi)\b/.test(t)) return "You're welcome.";
  if (/\b(are you (a |an )?(bot|robot|ai|human|real|person)|who are you|what are you|esti (un )?(robot|bot|om))\b/.test(t))
    return "I'm NextMove's assistant in this demo bank app: I read your accounts, calculate, and prepare actions for you to review. Nothing happens until you approve.";
  if (/^(hi|hello|hey|good (morning|afternoon|evening)|buna( ziua| seara| dimineata)?|salut|servus)\b/.test(t)) return "Hello.";
  return null;
}
