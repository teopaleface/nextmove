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

// Verbs that say "do this" in a capability's own vocabulary but name no subject: any subject the customer names (gym,
// Streamly, storage) outweighs them, and a request with nothing else is a bare stop (see `unspecified`).
const GENERIC = new Set(["cancel", "stop", "anuleaza", "anulez", "opreste"]);

// Symptoms of a subscription the customer already stopped: they point to the cancellation guarantee only when the
// request says it was stopped ("PulseGym is still charging" alone is about PulseGym).
const AFTER_CANCEL = new Set(["still charging", "still charged"]);
const STOPPED = /\b(?:cancel\w*|stop\w*|unsubscrib\w*|anul[aei]\w*|opri\w*|opre\w*)\b/;

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
  return score(normalized, cap, new Set());
}

/** Keyword score, leaving out the keywords in `ignore`; a capability id written out ("T2 ") counts 20. */
function score(normalized: string, cap: Routable, ignore: Set<string>): number {
  let s = 0;
  for (const k of cap.keywords) {
    if (ignore.has(k) || !hasKeyword(normalized, k)) continue;
    if (AFTER_CANCEL.has(k) && !STOPPED.test(normalized)) continue;
    s += GENERIC.has(k) ? 1 : normalizeRequest(k).length;
  }
  if (new RegExp(`(?<![a-z0-9])${esc(cap.id.toLowerCase())} `).test(normalized)) s += 20;
  return s;
}

// Where one request ends and the next begins: sentences, then "and", "also", "then" ("cancel FitFlow and check
// whether rent clears", "pause Streamly, also …"). A bare comma is not a join ("Hold on, what's my balance?"), nor is
// "and still" ("buy a phone and still reach my home goal" is one question), nor "plus" ("DashEats Plus"). A comma
// followed by another instruction is ("cancel the trial, pause Streamly and …").
const SENTENCE = /[.;!?]+(?:\s+|$)/;
const JOIN = /,?\s+(?:and also|and then|as well as|and(?!\s+(?:still|yet)\b)|also|then|si|apoi|iar)\s+|,\s+(?=(?:also|then|apoi|cancel|stop|pause|check|show|turn off|end|anuleaza|opreste|verifica)\b)/;
const MAX_INTENTS = 3;
// An opener that is not a request of its own ("Hold on, cancel the trial" is not a card hold).
const OPENER = /^(?:hold on|hang on|wait|ok|okay|well|so)\b,?\s*/;

// "Cancel everything", "stop", "anulează": a stop with nothing named. Pause, block and hold count as the verb only next
// to "everything" or "all", since alone they are a capability's own subject ("Pause instead of paying").
const STOP_VERB = /\b(?:cancel|cancels|cancelling|canceling|cancellation|stop|stops|stopping|unsubscribe|terminate|anula|anuleaza|anulez|anulati|opreste|opresc|opriti|renunt|renunta)\b/;
const BULK = /\b(?:everything|all|every one|toate|tot)\b/;
const BULK_VERBS = new Set([...GENERIC, "pause", "break", "block", "hold"]);

// Things a bank app does that this demo does not. The reply says so instead of routing a stray word ("block" is the
// Trial Shield's merchant block, "forgot" a forgotten trial).
const OUT_OF_SCOPE: [RegExp, string][] = [
  [/\b(?:block|freeze|unfreeze|unblock|lock|unlock|cancel|deactivate)\w* (?:my |the |this |a |our )?(?:debit |credit |bank |business |lost |stolen )?cards?\b(?! (?:charge|check|cover|on file|updater|subscription|payment))|\bblocheaz\w* (?:\w+ )?card\w*/, "block, freeze or cancel a card from chat (Home → Cards has a Freeze card button you approve yourself)"],
  [/\b(?:password|passwords|passcode|parola|parolei)\b|\b(?:can'?t|cannot|forgot\w*|unable to) (?:to )?(?:log ?in|sign ?in)\b/, "help with passwords or signing in"],
  [/\bpin(?: code)?s?\b/, "show or change a card PIN"],
  [/\b(?:close|closing|delete|deleting|terminate)\w* (?:my |the |this |a |an |our )?(?:\w+ )?account\b|\binchid\w* (?:\w+ )?cont(?:ul)?\b/, "close an account"],
  [/\b(?:open|opening|create)\w* (?:me )?(?:a |an |my |another |one more )?(?:new |second |joint |savings |business |current )?account\b|\bnew account\b|\bdeschid\w* (?:\w+ )?cont(?:ul)?\b/, "open an account"],
];

export interface Intent<C extends Routable> {
  c: C;
  /** Named inside a what-would-happen question: analyse it, never prepare it. */
  hypothetical: boolean;
}

export interface Route<C extends Routable> {
  matches: { c: C; score: number }[];
  /** Score of a balance/accounts question; the overview wins when it is at least the best capability's score. */
  overview: number;
  /** The only capability words were inside a negated clause ("don't cancel my trial"): show, never prepare. */
  declined: boolean;
  /** "What would happen if I cancelled …": show, never prepare. */
  hypothetical: boolean;
  /** Each distinct capability a separate part of the request names, in order, at most three. Two or more: a request with several parts. */
  intents: Intent<C>[];
  /** A stop or cancel with nothing named ("cancel everything", "stop"): ask what, never prepare in bulk. */
  unspecified: boolean;
  /** Something this demo cannot do ("block my card"), as a phrase for the reply; null otherwise. */
  outOfScope: string | null;
}

const rankAll = <C extends Routable>(t: string, caps: C[], ignore = new Set<string>()) =>
  caps.map((c) => ({ c, score: score(t, c, ignore) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
const overviewScore = (t: string) => OVERVIEW.filter((k) => hasKeyword(t, k)).reduce((s, k) => s + k.length, 0);
/** Something other than a bare verb is named. */
const named = (t: string, c: Routable, ignore = GENERIC) => score(t, c, ignore) > 0;

/** The capability each part of the request names, in order; a part inside a what-would-happen question is flagged. */
function intentsOf<C extends Routable>(kept: string, caps: C[]): Intent<C>[] {
  const out: Intent<C>[] = [];
  for (const sentence of kept.split(SENTENCE).map((s) => s.replace(OPENER, ""))) {
    let hypothetical = false;
    for (const part of sentence.split(JOIN)) {
      hypothetical ||= HYPOTHETICAL.test(part);
      const best = rankAll(part, caps)[0];
      if (!best || !named(part, best.c) || best.score <= overviewScore(part)) continue;
      const seen = out.find((x) => x.c.id === best.c.id);
      if (seen) seen.hypothetical &&= hypothetical;
      else out.push({ c: best.c, hypothetical });
    }
  }
  return out.slice(0, MAX_INTENTS);
}

export function routeRequest<C extends Routable>(text: string, caps: C[]): Route<C> {
  const full = normalizeRequest(text);
  const kept = withoutNegated(full);
  const overview = overviewScore(kept);
  const outOfScope = OUT_OF_SCOPE.find(([re]) => re.test(kept))?.[1] ?? null;
  let matches = rankAll(kept, caps);
  let declined = false;
  // Only a negated subject ("don't cancel my FitFlow trial"); a negated bare verb ("don't cancel anything") names nothing.
  if (!matches.length && kept !== full && !overview) {
    matches = rankAll(full, caps).filter((x) => named(full, x.c));
    declined = matches.length > 0;
  }
  const bulk = BULK.test(kept);
  const unspecified = !outOfScope && !overview && !declined && (STOP_VERB.test(kept) || (bulk && /\b(?:paus|block|hold|break|freez)\w*/.test(kept))) && !caps.some((c) => named(kept, c, bulk ? BULK_VERBS : GENERIC));
  return { matches, overview, declined, hypothetical: HYPOTHETICAL.test(full), intents: declined ? [] : intentsOf(kept, caps), unspecified, outOfScope };
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
