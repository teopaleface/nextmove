// Checks on text the planner writes for the customer: final answers and its own free-form questions. The planner
// only reads, calculates, asks and prepares, so its text may cite only numbers and dates that NextMove's tools
// produced or the customer wrote, may not claim that anything was carried out, may not send the customer to a
// link and may not ask for a PIN, password or card number. Phrases a tool result itself states pass; merchant
// names (provider-controlled text) never vouch for anything.

/** Steps whose result NextMove produced. final_answer and ask_user echo the model's own text, so they never vouch for it. */
export const fromTools = (s: { tool?: string }) => s.tool !== "final_answer" && s.tool !== "ask_user";

/**
 * Fold compatibility forms (fullwidth digits, non-breaking spaces, ligatures) and drop invisible and direction-control
 * characters, so "I can​celled" or "１５００ RON" cannot slip past the checks while reading the same on screen.
 */
export function plainText(s: string) {
  return s.normalize("NFKC").replace(/[­͏؜ᅟᅠ᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g, "");
}

/** A word or phrase on its own, with letters in any script (\b only knows ASCII letters). */
const word = (alt: string) => `(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`;

/* -------------------------------------------------------------------------------------------- numbers */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, ian: 1, ianuarie: 1, feb: 2, february: 2, februarie: 2, mar: 3, march: 3, martie: 3, apr: 4, april: 4, aprilie: 4,
  may: 5, mai: 5, jun: 6, june: 6, iun: 6, iunie: 6, jul: 7, july: 7, iul: 7, iulie: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  septembrie: 9, oct: 10, october: 10, octombrie: 10, nov: 11, november: 11, noiembrie: 11, dec: 12, december: 12, decembrie: 12,
};
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
// "mai" is also Romanian for "more" ("3 mai multe"): after a day number it is a month only when no word follows.
const DAY_MONTH = MONTH.replace(/\|mai(?=\||$)/, "|mai(?!\\s+\\p{L})");
const DATE_FORMS: { re: RegExp; read: (m: RegExpMatchArray) => [number, number][] }[] = [
  { re: /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, read: (m) => [[Number(m[2]), Number(m[3])]] },
  // 15.11.2026 or 11/15/2026: either order counts.
  { re: /(?<![\d.,/])(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})(?![\d.,/])/g, read: (m) => [[Number(m[2]), Number(m[1])], [Number(m[1]), Number(m[2])]] },
  { re: new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${DAY_MONTH})\\.?(?![\\p{L}])`, "giu"), read: (m) => [[MONTHS[m[2].toLowerCase()], Number(m[1])]] },
  {
    // November 15 / Nov. 15th; "may" and "mai" ("more" in Romanian) only as a capitalised English month.
    re: new RegExp(`(?<![\\p{L}])(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d.,]\\d|\\d)`, "giu"),
    read: (m) => (/^mai$/i.test(m[1]) || (/^may$/i.test(m[1]) && m[1] !== "May") ? [] : [[MONTHS[m[1].toLowerCase()], Number(m[2])]]),
  },
];

/** Calendar dates in a text, as month-day keys, with where they are. */
function datesIn(text: string) {
  const out: { at: number; raw: string; keys: string[] }[] = [];
  for (const f of DATE_FORMS)
    for (const m of text.matchAll(f.re)) {
      const keys = f.read(m).filter(([mo, d]) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31).map(([mo, d]) => `date:${mo}-${d}`);
      if (keys.length && !out.some((o) => m.index! < o.at + o.raw.length && o.at < m.index! + m[0].length)) out.push({ at: m.index!, raw: m[0], keys });
    }
  return out;
}

const UNITS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|" +
  "unu|una|doi|două|doua|trei|patru|cinci|șase|sase|șapte|sapte|opt|nouă|noua|zece|unsprezece|doisprezece|douăsprezece|douăzeci|douazeci|treizeci|patruzeci|cincizeci|șaizeci|saizeci|șaptezeci|saptezeci|optzeci|nouăzeci|nouazeci";
/** Amounts written out in words: a scale word, or a number word next to a currency or "percent". */
const WORD_AMOUNT = new RegExp(
  `${word("hundreds?|thousands?|millions?|billions?|sute|mii|milioane|miliarde|milion|miliard")}|${word(`(?:${UNITS})(?:[\\s-]+(?:${UNITS}|and|și|si))*\\s+(?:ron|lei|euros?|eur|dollars?|percent|per cent|procent|la sută|la suta)`)}`,
  "giu",
);
const wordAmounts = (text: string) => [...text.matchAll(WORD_AMOUNT)].map((m) => ({ at: m.index!, raw: m[0] }));

const TOOL_NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** Numbers (and dates, and amounts in words) the planner may cite: everything tools returned, plus what the customer wrote. */
export function allowedNumbers(steps: { tool?: string; result: any }[], customerText: string) {
  const out = new Set<string>();
  const addMinor = (v: number) => {
    out.add(String(v));
    if (Number.isInteger(v)) {
      out.add(String(v / 100));
      out.add((v / 100).toFixed(2));
      out.add(String(Math.abs(v / 100)));
      out.add(Math.abs(v / 100).toFixed(2));
    }
  };
  const addText = (s: string) => {
    for (const m of s.matchAll(TOOL_NUMBER)) out.add(m[0].replace(/,/g, ""));
    for (const d of datesIn(s)) for (const k of d.keys) out.add(k);
    for (const w of wordAmounts(s)) out.add(`word:${w.raw.toLowerCase().replace(/\s+/g, " ")}`);
  };
  // ISO timestamps carry the date the customer sees ("2026-10-30T09:00:00Z" is "30 Oct").
  const walk = (x: any) => {
    if (typeof x === "number") addMinor(x);
    else if (typeof x === "string") addText(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  steps.filter(fromTools).forEach((s) => walk(s.result));
  addText(customerText);
  // The customer's own Romanian-style amounts ("1.500 lei") count as written, too.
  for (const m of customerText.matchAll(/\d[\d.,]*\d/g)) {
    out.add(m[0].replace(/\./g, "").replace(/,/g, "."));
    out.add(m[0].replace(/,/g, ""));
  }
  return out;
}

const AMOUNT_AFTER = /^\s?(?:ron|lei|eur|euros?|usd|dollars?|€|\$|%|percent|per cent|procent)/i;
const AMOUNT_BEFORE = /(?:ron|lei|eur|usd|€|\$)\s?$/i;
// 1 500 (space-grouped thousands) first, then 1,500.50 / 1.500,50 / 12.99 / 7.
const NUMBER = /(\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?(?![\d.,]*\d)|\d(?:[\d.,]*\d)?)(\s?[kK]\b)?/g;

export function checkNumbers(text: string, allowed: Set<string>) {
  const bad: string[] = [];
  let rest = plainText(text);
  // Digits from other scripts (٥٠٠, ५००) never match a NextMove number.
  for (const m of rest.matchAll(/[^\P{Nd}0-9]+/gu)) bad.push(m[0]);
  const blank = (at: number, raw: string) => (rest = rest.slice(0, at) + " ".repeat(raw.length) + rest.slice(at + raw.length));
  for (const d of datesIn(rest)) {
    if (!d.keys.some((k) => allowed.has(k))) bad.push(d.raw.trim());
    blank(d.at, d.raw);
  }
  for (const w of wordAmounts(rest)) {
    if (!allowed.has(`word:${w.raw.toLowerCase().replace(/\s+/g, " ")}`)) bad.push(w.raw);
    blank(w.at, w.raw);
  }
  for (const m of rest.matchAll(NUMBER)) {
    const raw = m[1].replace(/[   ]/g, "");
    const thousands = Boolean(m[2]);
    const after = rest.slice(m.index! + m[0].length, m.index! + m[0].length + 9);
    const before = rest.slice(Math.max(0, m.index! - 5), m.index!);
    const amount = AMOUNT_AFTER.test(after) || AMOUNT_BEFORE.test(before);
    // Read the token both ways: 2,050.5 (English) and 2.050,5 (Romanian). It passes if either reading is a NextMove
    // number. Next to a currency, one separator before exactly three digits is a thousands separator (1.500 RON).
    const readings = (amount && /^[1-9]\d{0,2}[.,]\d{3}$/.test(raw) ? [raw.replace(/[.,]/, "")] : [raw.replace(/,/g, ""), raw.replace(/\./g, "").replace(/,/g, ".")]).map((n) =>
      thousands ? String(Number(n) * 1000) : n,
    );
    if (readings.some((n) => allowed.has(n) || allowed.has(n.replace(/\.00$/, "")) || allowed.has(Number(n).toFixed(2)))) continue;
    // Day numbers and years are fine in prose, but never as an amount or a percentage.
    if (!amount && !thousands && /^\d+$/.test(raw) && (Number(raw) <= 31 || /^20\d\d$/.test(raw))) continue;
    bad.push(m[0].trim());
  }
  return bad;
}

/* --------------------------------------------------------------------------------------------- claims */

// Something was carried out ("I cancelled it", "has been paid", "is now paused", "am anulat", "s-a plătit"). The planner
// can only read, calculate, ask and prepare, so such a claim is false unless a tool said it.
const OUTCOME = "cancell?ed|paid|stopped|paused|frozen|transferred|moved|sent|submitted|turned off|switched off|activated|deactivated|blocked|refunded|approved|executed|disputed|booked|ordered|renewed|ended|closed|terminated|unsubscribed|off";
// A state that only an executed action produces; "is paid" or "is closed" also describe schedules and shops, so they stay out.
const STATE = "cancell?ed|paused|frozen|stopped|blocked|refunded|turned off|switched off|transferred|disputed|approved|executed|deactivated|terminated|unsubscribed";
const ADVERBS = "(?:(?:already|now|just|also|successfully|finally|(?:gone|went)\\s+ahead\\s+and)\\s+){0,3}";
const ACT = "cancel|pay|stop|pause|freeze|transfer|send|submit|turn off|switch off|block|refund|approve|execute|dispute|book|order|renew|terminate|unsubscribe";
const ACTING = "cancell?ing|paying|stopping|pausing|freezing|transferring|sending|submitting|turning off|switching off|blocking|refunding|approving|executing|disputing|booking|ordering|terminating|unsubscribing";
const RO = "anulat|plătit|platit|achitat|oprit|suspendat|înghețat|inghetat|înghetat|transferat|virat|trimis|mutat|dezactivat|blocat|rambursat|aprobat|executat|reziliat|închis|inchis|contestat|rezervat|comandat|reînnoit|reinnoit";
const RO_STATE = "anulat|suspendat|înghețat|inghetat|înghetat|oprit|blocat|dezactivat|rambursat|aprobat|executat|reziliat|transferat";
const RO_ACT = "anul|plăt|plat|achit|opr|suspend|îngheț|inghet|transfer|vir|trimit|bloc|dezactiv|aprob|execut|rezili";
const NOT_RO = "(?<![\\p{L}])(?<!\\bnu\\s+)(?<!\\bn-)";
const ro = (aux: string, verbs: string) => new RegExp(`${NOT_RO}(?:${aux})\\s+(?:(?:deja|acum|cu\\s+succes|și|si)\\s+){0,2}(?:${verbs})\\p{L}*`, "giu");

/** Always a claim. */
const CLAIMS = [
  new RegExp(`\\b(?:(?:i|we|nextmove)(?:'ve|'d|\\s+have|\\s+has|\\s+had)?|(?:has|have)\\s+been|(?:is|are)\\s+now)\\s+${ADVERBS}(?:${OUTCOME})\\b`, "gi"),
  new RegExp(`\\b(?:was|were|got|has\\s+been|have\\s+been)\\s+${ADVERBS}(?:${STATE})\\b`, "gi"),
  new RegExp(`\\bsuccessfully\\s+(?:${OUTCOME})\\b`, "gi"),
  ro("am|amu|a\\s+fost|au\\s+fost|s-a|s-au|s-au\\s+fost", RO),
];
/** A claim unless the same sentence makes it conditional on the customer's approval ("once you approve, it is paused"). */
const UNLESS_APPROVED = [
  new RegExp(`\\b(?:is|are|gets|get|it's|that's|everything's)\\s+${ADVERBS}(?:${STATE})\\b`, "gi"),
  new RegExp(`\\b(?:i|we|nextmove)(?:'ll|\\s+will|'m\\s+going\\s+to|\\s+am\\s+going\\s+to|'re\\s+going\\s+to|\\s+are\\s+going\\s+to|\\s+is\\s+going\\s+to)\\s+(?:(?:now|just|also|immediately|go\\s+ahead\\s+and)\\s+){0,2}(?:${ACT})\\b`, "gi"),
  new RegExp(`\\b(?:i|we)(?:'m|\\s+am|'re|\\s+are)\\s+(?:(?:now|already|just)\\s+)?(?:${ACTING})\\b`, "gi"),
  ro("este|e|sunt|acum\\s+e", RO_STATE),
  new RegExp(`${NOT_RO}(?:voi|vom|o\\s+să|o\\s+sa)\\s+(?:(?:acum|imediat)\\s+)?(?:${RO_ACT})\\p{L}*`, "giu"),
];
const APPROVAL =
  /\b(?:once|after|when|if|as soon as|only when|only after)\s+you(?:'ve|\s+have)?\s+(?:approve|confirm)|\bafter (?:your )?approval|\bwith your approval|(?:după|dupa)\s+ce\s+(?:aprobi|confirmi)|(?:dacă|daca|când|cand|odată ce|odata ce)\s+(?:aprobi|confirmi)|(?:după|dupa)\s+aprobare|\b(?:once|when|if|after)\s+(?:it's\s+|it\s+is\s+)?approved\b/i;

/** Lower-cased tool texts, with provider-controlled names cut out so a merchant called "X has been cancelled" vouches for nothing. */
function toolTexts(steps: { tool?: string; result: any }[], untrusted: string[]) {
  const cut = untrusted.map((u) => u.toLowerCase().trim()).filter((u) => u.length >= 3);
  const said: string[] = [];
  const walk = (x: any) => {
    if (typeof x === "string") {
      let t = plainText(x).toLowerCase().replace(/\s+/g, " ");
      for (const u of cut) t = t.split(u).join(" \u0000 ");
      said.push(t);
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  steps.filter(fromTools).forEach((s) => walk(s.result));
  return said;
}

const sentences = (text: string) => text.replace(/[’‘ʼ`´]/g, "'").split(/(?<=[.!?;])\s+|\n+/);

/** Outcome claims in the planner's text that no tool result contains. */
export function checkClaims(text: string, steps: { tool?: string; result: any }[], untrusted: string[] = []) {
  const said = toolTexts(steps, untrusted);
  const out: string[] = [];
  for (const s of sentences(plainText(text))) {
    const found = [...CLAIMS.flatMap((re) => [...s.matchAll(re)]), ...(APPROVAL.test(s) ? [] : UNLESS_APPROVED.flatMap((re) => [...s.matchAll(re)]))];
    for (const m of found) {
      const phrase = m[0].replace(/\s+/g, " ");
      if (!said.some((t) => t.includes(phrase.toLowerCase())) && !out.includes(phrase)) out.push(phrase);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------ links, secrets */

const LINK = /\b(?:https?:\/\/|hxxps?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|ro|net|org|io|app|co|info|biz|xyz|link|ly|me|eu|online|site|top|click|bank|support|help|login|page|example)\b(?:\/\S*)?/gi;
const SECRET = "pin(?:\\s*code)?|passwords?|passcodes?|parol[aăei]\\p{L}*|cvv2?|cvc2?|security code|cod(?:ul)? de securitate|card numbers?|full card|card details|num[aă]r(?:ul)?\\s+(?:de\\s+)?card\\p{L}*|datele (?:de pe )?card\\p{L}*|one[- ]time (?:pass)?(?:code|word)|otp|verification code|sms code|cod(?:ul)? (?:primit )?(?:prin |din )?sms|login details|credentials|sign[- ]in details|seed phrase|recovery phrase";
const ASK = "send|share|enter|type|give|tell|provide|reply|confirm|verify|write|text|read out|paste|submit|introdu\\p{L}*|trimite\\p{L}*|spune\\p{L}*|comunic\\p{L}*|scrie\\p{L}*|confirm\\p{L}*|dă-?mi|da-?mi";
const SECRET_ASK = [
  new RegExp(`${word(ASK)}[^.!?\\n]{0,60}?${word(SECRET)}`, "giu"),
  new RegExp(`\\bwhat(?:'s|\\s+is|\\s+are)\\s+your\\s+(?:${SECRET})`, "giu"),
  new RegExp(`${word("care\\s+(?:este|e)|cum\\s+(?:este|e)")}\\s+(?:${SECRET})`, "giu"),
];
const NEVER = /\b(?:never|don't|do not|nobody|no one|won't|will not)\b|(?<![\p{L}])(?:niciodat\p{L}*|nu)(?![\p{L}])/iu;

/** Links the planner wrote that no tool result contains: NextMove never sends the customer anywhere. */
export function checkLinks(text: string, steps: { tool?: string; result: any }[], untrusted: string[] = []) {
  const said = toolTexts(steps, untrusted);
  return [...plainText(text).matchAll(LINK)].map((m) => m[0]).filter((l) => !said.some((t) => t.includes(l.toLowerCase())));
}

/** Requests for a PIN, password, card number or one-time code. "Never share your PIN" is a warning, not a request. */
export function checkSecrets(text: string, steps: { tool?: string; result: any }[], untrusted: string[] = []) {
  const said = toolTexts(steps, untrusted);
  const out: string[] = [];
  for (const s of sentences(plainText(text))) {
    if (NEVER.test(s)) continue;
    for (const re of SECRET_ASK) for (const m of s.matchAll(re)) if (!said.some((t) => t.includes(m[0].toLowerCase()))) out.push(m[0]);
  }
  return out;
}

/**
 * Why a planner text may not be shown to the customer, as the provenance line for the answer, or null. Links are
 * never quoted back, so the warning itself cannot carry them.
 */
export function textProblem(text: string, steps: { tool?: string; result: any }[], customerText: string, untrusted: string[] = []): string | null {
  const bad = checkNumbers(text, allowedNumbers(steps, customerText));
  if (bad.length) return `Withheld a model sentence citing ${bad.slice(0, 3).join(", ")}, which no calculation produced`;
  const claims = checkClaims(text, steps, untrusted);
  if (claims.length) return `Withheld a model sentence saying "${claims[0]}": nothing is carried out until you approve it`;
  if (checkLinks(text, steps, untrusted).length) return "Withheld a model sentence with a link: NextMove never sends you to another site";
  if (checkSecrets(text, steps, untrusted).length) return "Withheld a model sentence asking for a PIN, password, card number or code: NextMove never asks for them";
  return null;
}
