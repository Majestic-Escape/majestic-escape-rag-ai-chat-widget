// Deterministic corrections applied to the model's reading before it is
// cross-checked. Each one answers a misreading seen in live evaluation
// (eval/README.md lists the cases).
//
// One rule above all: a guard never deletes a requirement the model read. A
// doubtful reading is kept (it shows in the filters line, and at worst hides
// some stays) or sent back as a question by crossCheck — because a requirement
// that silently disappears lets a stay be shown as a match against what the
// customer asked. An earlier version of this file dropped "invented" fields and
// was wrong in exactly that way.

import { isRealDate } from "./dates";
import { BOUND_NEGATION, hasDateCue, hasNegation, headcount, negatesSomething, numbersIn, peopleAdded } from "./numbers";
import type { AmenityKey } from "./types";
import type { Proposal } from "./understand";
import type { SearchState } from "./types";

const ONE_WORD: Record<string, AmenityKey> = {
  pool: "pool", swimming: "pool", wifi: "wifi", internet: "wifi", parking: "free-parking",
  ac: "air-conditioning", aircon: "air-conditioning", airconditioning: "air-conditioning", airconditioned: "air-conditioning",
  kitchen: "kitchen", rasoi: "kitchen", tv: "tv", television: "tv", workspace: "workspace", desk: "workspace",
  washing: "washing", washer: "washing", laundry: "washing", bbq: "bbq", barbecue: "bbq", barbeque: "bbq", grill: "bbq",
  lake: "lake", lakeside: "lake", beach: "beach", beachfront: "beach", firepit: "firepit", bonfire: "firepit",
  patio: "patio", extinguisher: "fire-extinguisher", billiards: "pool-table",
  "पूल": "pool", "वाईफाई": "wifi", "एसी": "air-conditioning", "पार्किंग": "free-parking", "किचन": "kitchen", "रसोई": "kitchen", "टीवी": "tv", "बीच": "beach",
};
const TWO_WORDS: Record<string, AmenityKey> = {
  "pool table": "pool-table", "wi fi": "wifi", "air conditioning": "air-conditioning", "air conditioned": "air-conditioning", "air conditioner": "air-conditioning",
  "a c": "air-conditioning", "work space": "workspace", "first aid": "first-aid", "outdoor dining": "outdoor-dining",
  "fire pit": "firepit", "smoke alarm": "smoke-alarm", "smoke detector": "smoke-alarm", "t v": "tv", "car park": "free-parking",
  "झील किनारे": "lake", "jheel kinare": "lake", "lake side": "lake", "beach front": "beach",
};
const THREE_WORDS: Record<string, AmenityKey> = { "झील के किनारे": "lake", "jheel ke kinare": "lake", "on the beach": "beach" };
const NEGATORS = new Set(["no", "not", "without", "except", "excluding", "dont", "don't", "doesnt", "doesn't", "isn't", "isnt", "can't", "cant", "cannot", "won't", "aren't", "never", "nahi", "nahin", "nhi", "bina", "mat", "नहीं", "बिना"]);
// Words that say "this stay must NOT have it", as opposed to "I no longer need it".
const EXCLUDERS = new Set(["without", "bina", "excluding", "except", "बिना"]);
// Hindi negators stand after what they negate; English "not" / "isn't" can too ("pool not needed").
const NEG_AFTER_ONLY = new Set(["nahi", "nahin", "nhi", "mat", "नहीं"]);
const NEG_AFTER = new Set([...NEG_AFTER_ONLY, "not", "isn't", "isnt", "aren't"]);
const NEGATION_ONLY = /^\s*(not|nahi|nahin|nhi|no need|zaroorat nahi|zarurat nahi|jarurat nahi|नहीं)(?![\p{L}\p{M}])/iu;

const tokens = (message: string) => message.toLowerCase().split(/[^\p{L}\p{M}\p{N}']+/u).filter(Boolean);

/** Every amenity the message names, with the token index where it is named. */
function amenityMentions(message: string): { key: AmenityKey; at: number }[] {
  const t = tokens(message);
  const out: { key: AmenityKey; at: number }[] = [];
  for (let i = 0; i < t.length; i++) {
    const three = i + 2 < t.length ? THREE_WORDS[`${t[i]} ${t[i + 1]} ${t[i + 2]}`] : undefined;
    if (three) { out.push({ key: three, at: i }); i += 2; continue; }
    const two = i + 1 < t.length ? TWO_WORDS[`${t[i]} ${t[i + 1]}`] : undefined;
    if (two) { out.push({ key: two, at: i }); i++; continue; } // "pool table" is not a pool
    const one = ONE_WORD[t[i]!];
    if (one) out.push({ key: one, at: i });
  }
  return out;
}

export const amenitiesNamed = (message: string): AmenityKey[] => [...new Set(amenityMentions(message).map((m) => m.key))];

/** Amenities the message negates: "no pool", "without a pool", "pool nahi chahiye", "pool not needed". */
export function negatedAmenities(message: string): { key: AmenityKey; excluded: boolean }[] {
  // A negation reaches only its own clause ("pool nahi chahiye par AC chahiye", "no AC, pool or lakeside"),
  // and a bound ("3000 se zyada nahi") negates nothing.
  // "pool, not needed": a clause that is only a negation belongs to the one before it
  const clauses: string[] = [];
  for (const c of message.replace(BOUND_NEGATION, " ").split(CLAUSE)) {
    if (clauses.length && amenityMentions(c).length === 0 && NEGATION_ONLY.test(c)) clauses[clauses.length - 1] += ` ${c}`;
    else clauses.push(c);
  }
  return clauses.flatMap(negatedInClause);
}
const CLAUSE = /[,.;!?।]+|\s(?:but|lekin|par|magar|bas|however|पर|लेकिन|मगर|बस)\s/i;

function negatedInClause(message: string): { key: AmenityKey; excluded: boolean }[] {
  // "pata nahi" / "पता नहीं" = "I don't know": that "nahi" negates nothing
  // …and "koi issue / problem / dikkat nahi" = no problem: that "nahi" negates nothing either
  const t = tokens(message).map((w, i, all) => (NEGATORS.has(w) && /^(pata|maloom|malum|issue|problem|dikkat|tension|chinta|farak|fark|पता|मालूम|दिक्कत|समस्या|परेशानी|फर्क|फ़र्क|टेंशन)$/.test(all[i - 1] ?? "") ? "_" : w));
  const out: { key: AmenityKey; excluded: boolean }[] = [];
  for (const m of amenityMentions(message)) {
    const before = t.slice(Math.max(0, m.at - 3), m.at);
    const after = t.slice(m.at + 1, m.at + 4);
    // English negates what follows ("no AC", "without a pool"); Hindi what comes before ("AC nahi chahiye"),
    // as does an English "pool not needed". So "a pool and no AC" negates only the AC.
    const negBefore = before.filter((w) => NEGATORS.has(w) && !NEG_AFTER_ONLY.has(w));
    const negAfter = after.slice(0, 3).filter((w) => NEG_AFTER.has(w));
    if (negBefore.length || negAfter.length) out.push({ key: m.key, excluded: [...before, ...after].some((w) => EXCLUDERS.has(w)) });
  }
  return out;
}

const addYear = (d: string) => `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
// A year counts as typed only when it is written as part of a date ("5 jan 2027",
// "05/01/2027", "2027-01-05") — "under 2000" is a budget.
const TYPED_YEAR = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*,?\s*20\d\d|\d\s*[\/-]\s*20\d\d|20\d\d\s*-\s*\d/i;

/** "30 dec to 2 jan" read as 2 Jan of THIS year, or "5 to 8 january" read as a
 *  January already gone: when the customer named no year, a date that only
 *  makes sense next year is moved there. A date earlier in the CURRENT month is
 *  left alone — that is a customer asking for a date that has passed, and
 *  crossCheck says so. */
function repairYears(message: string, set: Proposal["set"], today: string): void {
  const { checkIn, checkOut } = set;
  if (!isRealDate(checkIn) || !isRealDate(checkOut) || TYPED_YEAR.test(message)) return;
  let a = checkIn;
  let b = checkOut;
  // last year written for a date nobody gave a year to ("31 dec se 2 jan" → 2025-12-31 in Nov 2026): this year first
  if (Number(today.slice(0, 4)) - Number(a.slice(0, 4)) === 1) { a = addYear(a); b = addYear(b); }
  if (a < today && a.slice(0, 4) === today.slice(0, 4) && a.slice(5, 7) < today.slice(5, 7)) { a = addYear(a); b = addYear(b); }
  if (b <= a && b.slice(5, 7) < a.slice(5, 7)) b = addYear(b);
  if (isRealDate(a) && isRealDate(b)) { set.checkIn = a; set.checkOut = b; }
}

const addDays = (d: string, n: number) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) + n)).toISOString().slice(0, 10);
const WRITTEN_DATE = /(^|[^a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*([^a-z]|$)|\d\s*[\/-]\s*\d/i;
// One relative anchor each: which day the stay starts, counted from today.
const ANCHORS: [RegExp, (today: string) => string][] = [
  [/(day after tomorrow|parso|parson|(?<![\p{L}\p{M}])परसों(?![\p{L}\p{M}]))/iu, (t) => addDays(t, 2)],
  [/(tomorrow|(^|[^a-z])kal([^a-z]|$)|(?<![\p{L}\p{M}])कल(?![\p{L}\p{M}]))/iu, (t) => addDays(t, 1)],
  [/(tonight|today|(^|[^a-z])aaj([^a-z]|$)|(?<![\p{L}\p{M}])आज(?![\p{L}\p{M}]))/iu, (t) => t],
  // "this weekend" = the coming Saturday (today, if today is Saturday)
  [/(this|coming|is|iss)\s+weekend|weekend\s+(pe|par|ko)|इस\s+(वीकेंड|वीकएंड|सप्ताहांत)|(वीकेंड|वीकएंड)\s+(पर|में|को)/iu, (t) => addDays(t, (6 - new Date(t + "T00:00:00Z").getUTCDay() + 7) % 7)],
];

/** "this weekend", "tomorrow", "kal se 2 raat": the start day is arithmetic, not
 *  judgement — models differ on it (one read "this weekend" as Friday). When the
 *  message has exactly one such anchor and no written date, the start is set by
 *  the calendar and the length the model read is kept (a weekend is Sat → Mon). */
function repairRelativeDates(message: string, set: Proposal["set"], today: string): void {
  if (!isRealDate(set.checkIn) || !isRealDate(set.checkOut) || WRITTEN_DATE.test(message)) return;
  const hits = ANCHORS.filter(([re]) => re.test(message));
  // "day after tomorrow" also contains "tomorrow": the first (most specific) hit wins.
  if (hits.length === 0 || (hits.length > 1 && !/day after tomorrow/i.test(message))) return;
  const start = hits[0]![1](today);
  const weekend = /weekend/i.test(message);
  const says = /night|raat|days?([^a-z]|$)|din([^a-z]|$)/i.test(message);
  const nights = weekend && !says ? 2 : Math.max(1, Math.round((Date.parse(set.checkOut) - Date.parse(set.checkIn)) / 86_400_000));
  set.checkIn = start;
  set.checkOut = addDays(start, nights);
}

/** Words that let a requirement go ("koi bhi", "hata do", "no need"). Replacement words ("actually", "instead",
 *  "anywhere in goa") are not among them: they license only the value being replaced. */
export const REMOVAL_CUE = /forget|any\b|doesn'?t matter|does not matter|no longer|not (needed|required|necessary|important)|no need|remove|drop|skip|start over|new search|fresh|reset|clear|koi bhi|kuch bhi|chalega|hata|rehne do|chhod|zaroori nahi|jaruri nahi|हटा|छोड|कोई भी|कुछ भी|चलेगा|ज़रूरी नहीं|जरूरी नहीं|(issue|problem|dikkat|tension|chinta|fikar|fikr|farak|fark) (nahi|nahin|nhi)|no (issue|problem)|not an issue|दिक्कत नहीं|फर्क नहीं|फ़र्क नहीं|समस्या नहीं|चिंता नहीं|फिक्र नहीं|फ़िक्र नहीं/i;
// "no," / "नहीं," then the rest of the message: only with punctuation after it ("no pool" is a negation of the pool)
const LEADING_NO = /^\s*(no+|nope|nah|nahi|nahin|nhi|na|नहीं|नही|ना)(\s+(yaar|yar|bhai|ji|re|dear|sorry|नहीं))?\s*[,.!।]+\s*/iu;
const REPLACEABLE = ["place", "checkIn", "guests", "bedrooms", "beds", "bathrooms", "price", "propertyType", "placeType", "cancellation"] as const;
const MONTH: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  "जनवरी": 1, "फरवरी": 2, "फ़रवरी": 2, "मार्च": 3, "अप्रैल": 4, "मई": 5, "जून": 6, "जुलाई": 7, "अगस्त": 8, "सितंबर": 9, "सितम्बर": 9, "अक्टूबर": 10, "नवंबर": 11, "नवम्बर": 11, "दिसंबर": 12, "दिसम्बर": 12 };
const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?|जनवरी|फरवरी|फ़रवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|सितम्बर|अक्टूबर|नवंबर|नवम्बर|दिसंबर|दिसम्बर";
const monthOf = (w: string) => MONTH[w.toLowerCase().replace(/\.$/, "").slice(0, 3)] ?? MONTH[w];
/** Day-and-month dates the customer wrote, in order: "31 dec se 2 jan", "10 to 13 december", "dec 5". */
export function writtenDates(message: string): { d: number; m: number }[] {
  const text = message.toLowerCase().replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)));
  const out: { d: number; m: number; at: number }[] = [];
  const taken: [number, number][] = [];
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  // "10 to 13 december", "10-13 dec", "10 se 13 dec": both days take the month
  for (const x of text.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|se|till|until|tak)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MON})`, "giu"))) {
    const m = monthOf(x[3]!);
    if (m) { out.push({ d: +x[1]!, m, at: x.index! }, { d: +x[2]!, m, at: x.index! + 1 }); taken.push([x.index!, x.index! + x[0].length]); }
  }
  for (const x of text.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MON})`, "giu"))) {
    const m = monthOf(x[2]!);
    if (m && free(x.index!, x.index! + x[0].length)) { out.push({ d: +x[1]!, m, at: x.index! }); taken.push([x.index!, x.index! + x[0].length]); }
  }
  for (const x of text.matchAll(new RegExp(`(${MON})\\s*(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)`, "giu"))) {
    const m = monthOf(x[1]!);
    if (m && free(x.index!, x.index! + x[0].length)) out.push({ d: +x[2]!, m, at: x.index! });
  }
  return out.filter((x) => x.d >= 1 && x.d <= 31).sort((a, b) => a.at - b.at).map(({ d, m }) => ({ d, m }));
}
const md = (iso: string | undefined) => (iso ? `${Number(iso.slice(5, 7))}-${Number(iso.slice(8, 10))}` : "");
const pad = (n: number) => String(n).padStart(2, "0");

/** "31 dec se 2 jan" read as 1 February (day and month swapped): when the message writes exactly two
 *  dates and the reading names other days, the written days are used (years are repaired next). */
function repairWrittenDates(message: string, set: Proposal["set"]): void {
  const w = writtenDates(message);
  if (w.length !== 2 || !isRealDate(set.checkIn) || !isRealDate(set.checkOut)) return;
  const [a, b] = w as [{ d: number; m: number }, { d: number; m: number }];
  if (md(set.checkIn) === `${a.m}-${a.d}` && md(set.checkOut) === `${b.m}-${b.d}`) return;
  const y = Number(set.checkIn!.slice(0, 4));
  set.checkIn = `${y}-${pad(a.m)}-${pad(a.d)}`;
  set.checkOut = `${b.m < a.m ? y + 1 : y}-${pad(b.m)}-${pad(b.d)}`;
}

const ONE_DAY = /(tonight|today|tomorrow|(^|[^a-z])(aaj|kal)([^a-z]|$)|(?<![\p{L}\p{M}])(आज|कल)(?![\p{L}\p{M}]))/iu;
/** A check-in with a length but no check-out ("kal se 2 raat", "31 dec se teen raat"), a bare "tonight" /
 *  "kal ke liye" (one night, golden/README), or a weekend read only as "2 nights": the dates are arithmetic. */
function completeDates(message: string, set: Proposal["set"], nights: number | undefined, today: string, prev: SearchState): number | undefined {
  const typed = [...message.matchAll(LENGTH)];
  const n = nights ?? (typed.length === 1 ? (/^\d+$/.test(typed[0]![1]!) ? Number(typed[0]![1]) : LENGTH_WORDS[typed[0]![1]!.toLowerCase()]) : undefined);
  if (isRealDate(set.checkIn) && set.checkOut === undefined) {
    // "for 3 nights" earlier, then "12 jan se": the start arrives for the length already given (golden/README)
    if (!n && prev.nights && !prev.checkIn) { set.checkOut = addDays(set.checkIn!, prev.nights); return undefined; }
    if (n && n >= 1) { set.checkOut = addDays(set.checkIn!, n); return undefined; }
    if (ONE_DAY.test(message) && writtenDates(message).length === 0) { set.checkOut = addDays(set.checkIn!, 1); return undefined; }
    return nights;
  }
  if (set.checkIn === undefined && set.checkOut === undefined && !prev.checkIn && !WRITTEN_DATE.test(message)) {
    const hits = ANCHORS.filter(([re]) => re.test(message));
    if (hits.length === 0 || (hits.length > 1 && !/day after tomorrow/i.test(message))) return nights;
    if (/(^|[^a-z])aaj kal([^a-z]|$)/i.test(message)) return nights; // "aaj kal" = nowadays
    const start = hits[0]![1](today);
    const len = n ?? (/weekend|वीकेंड|वीकएंड|सप्ताहांत/i.test(message) ? 2 : ONE_DAY.test(message) ? 1 : undefined);
    if (!len) return nights;
    set.checkIn = start;
    set.checkOut = addDays(start, len);
    return undefined;
  }
  return nights;
}

const RESET_CUE = /\b(start(ing)? (over|again|afresh|fresh|from scratch)|new search|fresh (search|start)|from scratch|scratch (that|this|it|everything|all)|scrap (that|this|it|everything|all)|begin (again|afresh|anew)|(totally|completely|entirely|something) (different|new|else)|different (search|trip|plan)|reset|clear (it|all|everything|the search|filters)|forget (everything|all( that)?|it all)|naya search|nayi? (search|khoj)|phir se shuru|shuru se|sab (kuch )?(hatao|hata do|clear|bhool jao|chhodo|chhod do|chodo|chod do)|scratch se)\b|नया सर्च|नई खोज|फिर से शुरू|शुरू से|सब\s*(कुछ\s*)?छो(ड़|ड़)(ो|\s*दो)/i;

export function applyGuards(message: string, p: Proposal, prev: SearchState, today: string): Proposal {
  // "reset" with nothing to reset (a first message) changes nothing; it is not a removal to question
  const empty = !Object.keys(prev).some((k) => k !== "shownIds" && k !== "consentFor");
  if (p.reset && empty) p = { ...p, reset: false };
  // "nahi, goa mein dikhao" is a correction, not a new search: a reset proposed by the model is
  // honoured only when the customer said so; otherwise the reading is applied as a normal change.
  if (p.reset && !RESET_CUE.test(message)) p = { ...p, reset: false };
  // A removal must be asked for. "नहीं, गोवा में दिखाओ", "sorry I meant 22 to 24 dec", "anywhere in goa is fine
  // actually": the customer replaced a value. A removal the model added beyond that replacement is dropped,
  // which keeps the requirement (asking "what should I leave out?" answered a question nobody asked).
  // (a reading with an explicit change list is judged on its own quoted words instead: judgeRemovals)
  if (!p.changes && (p.unset.length || p.remove.length)) {
    const lead = message.match(LEADING_NO);
    const body = lead ? message.slice(lead[0].length) : message;
    const asked = REMOVAL_CUE.test(body) || negatesSomething(body) || DATES_DROPPED.test(body) || (p.reset && RESET_CUE.test(message));
    if (!asked) {
      const replaced = REPLACEABLE.filter((k) => p.set[k] !== undefined && prev[k] !== undefined);
      const keep = (u: string) => (replaced as readonly string[]).includes(u) || (u === "dates" && (p.set.checkIn !== undefined || p.nights !== undefined));
      p = { ...p, unset: p.unset.filter(keep), remove: [] };
    }
  }
  const set = { ...p.set };
  let unset = [...p.unset];
  let soft = [...p.soft];
  let remove = [...p.remove];
  repairWrittenDates(message, set);
  repairYears(message, set, today);
  repairRelativeDates(message, set, today);
  let nights = p.nights;
  if (p.intent === "search") nights = completeDates(message, set, nights, today, prev);

  // The group the customer described, part by part: "2 adults and a 6 year old" = 3, "2 couples" = 4,
  // "main akela hoon" = 1 (golden/README). Not for people being added ("ek dost aur aa raha hai").
  const group = p.intent === "search" && !ADDING.test(message) ? headcount(message) : null;
  if (group && (set.guests?.min ?? 0) !== group.total) set.guests = { min: group.total, ...(set.guests?.max !== undefined && set.guests.max > group.total ? { max: set.guests.max } : {}) };
  // People being added ("aur 2 bacche bhi hain", "ek dost aur aa raha hai"): the previous group plus them,
  // when that is the only number in the message (a model left the count unchanged; golden/README).
  const added = p.intent === "search" && prev.guests?.min ? peopleAdded(message) : [];
  if (added.length === 1 && Number.isFinite(added[0]) && numbersIn(message).required.every((n) => n === added[0])) set.guests = { min: prev.guests!.min! + added[0]! };

  // "ghar", "jagah", "place": no property type; "poora ghar", "entire house": the whole place (golden/README)
  if (set.propertyType === "house" && !HOUSE_WORD.test(message)) delete set.propertyType;
  if (!set.placeType && ENTIRE.test(message)) set.placeType = "entire";

  // "Pool not needed" / "pool nahi chahiye" after asking for a pool takes the
  // requirement away. But "without a pool" is an exclusion and stays one.
  if (set.amenitiesNone?.length) {
    const negated = negatedAmenities(message);
    const relax = set.amenitiesNone.filter(
      (a) => (prev.amenitiesAll?.includes(a) || prev.amenitiesAny?.includes(a)) && !negated.some((n) => n.key === a && n.excluded)
    );
    if (relax.length) {
      remove = [...new Set([...remove, ...relax])];
      const rest = set.amenitiesNone.filter((a) => !relax.includes(a));
      if (rest.length) set.amenitiesNone = rest;
      else delete set.amenitiesNone;
    }
  }

  // "Pool not needed" must not wipe every amenity requirement. (Seen live.)
  if (unset.includes("amenities")) {
    const named = amenitiesNamed(message);
    if (named.length) {
      unset = unset.filter((u) => u !== "amenities");
      remove = [...new Set([...remove, ...named])];
    }
  }

  // "स्विमिंग पूल नहीं चाहिए", "AC nahi chahiye" about something never asked for: an exclusion (golden/README).
  // About something asked for earlier it is a removal, which the model's "remove" already says.
  const had = (k: AmenityKey) => [prev.amenitiesAll, prev.amenitiesAny, prev.amenitiesNone].some((l) => l?.includes(k));
  const fresh = negatedAmenities(message).filter((n) => !had(n.key) && !set.amenitiesAll?.includes(n.key) && !set.amenitiesAny?.includes(n.key)).map((n) => n.key);
  if (fresh.length) {
    set.amenitiesNone = [...new Set([...(set.amenitiesNone ?? []), ...fresh])];
    remove = remove.filter((r) => !(fresh as string[]).includes(r));
  }

  let unsupported = p.unsupported;
  // "beachfront", "lakeside", "झील किनारे" written as an unsupported phrase: they are amenity keys
  const asAmenity = unsupported.map((u) => [u, AS_AMENITY[u.toLowerCase().replace(/^(a|an|the)\s+/, "").trim()]] as const).filter(([, k]) => k);
  if (asAmenity.length) {
    unsupported = unsupported.filter((u) => !asAmenity.some(([a]) => a === u));
    set.amenitiesAll = [...new Set([...(set.amenitiesAll ?? []), ...asAmenity.map(([, k]) => k!)])];
  }
  // "private pool": pool AND an unverifiable "private" (prompt rule 2). A model that kept only the pool
  // weakened the requirement; the private part is added back as unsupported (never shown as a match).
  const pool = set.amenitiesAll?.includes("pool") || set.amenitiesAny?.includes("pool");
  const privateClause = message.split(/[,.;!?]|\s(?:but|lekin|par|magar|पर|लेकिन)\s/i).find((c) => PRIVATE_POOL.test(c));
  if (privateClause && !hasNegation(privateClause)) {
    // a pool AND an unverifiable "private": never only one of them (golden/README)
    if (!pool) set.amenitiesAll = [...new Set([...(set.amenitiesAll ?? []), "pool" as AmenityKey])];
    if (!unsupported.some((u) => PRIVATE_WORD.test(u))) unsupported = [...unsupported, "private pool"];
    soft = soft.filter((x) => !PRIVATE_WORD.test(x));
  }
  // "beach ke paas", "near the beach" is a distance, which no field holds; the beach amenity
  // (beachfront / beach access) is a different, narrower thing. Kept as unsupported, not dropped.
  if (set.amenitiesAll?.includes("beach") && NEAR_BEACH.test(message) && !ON_BEACH.test(message)) {
    const rest = set.amenitiesAll.filter((a) => a !== "beach");
    if (rest.length) set.amenitiesAll = rest;
    else delete set.amenitiesAll;
    if (!unsupported.some((u) => /beach|बीच/i.test(u))) unsupported = [...unsupported, "near the beach"];
  }

  // "sasta room", "cheap stay" with no amount: a wish, not a number (golden/README). A price the model wrote
  // without a typed number is dropped rather than questioned.
  if (set.price && numbersIn(message).required.length === 0) {
    if (CHEAP.test(message)) {
      delete set.price;
      soft = [...new Set([...soft, "cheaper"])];
    } else if (prev.price && REMOVAL_CUE.test(message) && BUDGET_WORD.test(message)) {
      // "budget ka koi issue nahi" read as a new ceiling: the customer let the budget go (golden/README)
      delete set.price;
      unset = [...new Set([...unset, "price" as const])];
    }
  }

  return phrasing(message, repairLength(message, { ...p, set, unset, remove, unsupported, soft, nights }, prev), prev);
}

const ADDING = /(?<![\p{L}\p{M}])(bhi|also|too|more|extra|additional|joining|join|coming|aa rah[aie]|aayega|aayegi|aayenge|भी|आ रह[ाीे])(?![\p{L}\p{M}])/iu;
const HOUSE_WORD = /(?<!(entire|whole|full|poora|pura)\s+)\bhouses?\b|मकान/i;
const ENTIRE = /(?<![\p{L}\p{M}])(poora|pura|poori|puri|पूरा|पूरी|entire|whole)\s+(ghar|घर|house|home|place|jagah|जगह|flat|apartment|villa|property)(?![\p{L}\p{M}])/iu;
const AS_AMENITY: Record<string, AmenityKey> = {
  beachfront: "beach", "beach front": "beach", "beach access": "beach", "on the beach": "beach", "direct beach access": "beach",
  lakeside: "lake", "lake side": "lake", lakefront: "lake", "झील किनारे": "lake", "झील के किनारे": "lake", "jheel kinare": "lake", "jheel ke kinare": "lake",
  bonfire: "firepit", "swimming pool": "pool",
};
const BUDGET_WORD = /budget|price|paisa|paise|bajat|बजट|kimat|keemat|कीमत|daam|दाम|rate/i;
const CHEAP = /(?<![\p{L}\p{M}])(sasta|sasti|saste|cheap|cheaper|affordable|budget[- ]friendly|low budget|kam budget|सस्ता|सस्ती|सस्ते)(?![\p{L}\p{M}])/iu;

const PRIVATE_POOL = /(private|pvt|prvt|own|personal|apna|apni|khud ka|khudka)\s+(swimming\s+)?pool|प्राइवेट\s*पूल|निजी\s*पूल|अपना\s*पूल/i;
const PRIVATE_WORD = /private|pvt|prvt|own|personal|apna|apni|khud|प्राइवेट|निजी|अपना/i;
const NEAR_BEACH = /(near|close to|next to|walking distance (to|from)|walkable to|not far from)\s+(the\s+|a\s+)?beach|beach\s+(ke|se|k)\s+(paas|pass|nazdeek|najdik|najdeek|kareeb|karib|door nahi|dur nahi)|beach (nearby|close by)|बीच\s+के\s+(पास|नज़दीक|नजदीक|करीब)/i;
const ON_BEACH = /beach\s*-?\s*(front|access|facing|side)|on the beach/i;

/** The customer is letting go of the dates ("forget the dates", "dates are flexible", "some other time"). */
export const DATES_DROPPED = /(?<![a-z])(forget|flexible|not fixed|not sure|any (date|dates|time)|some ?other|other (date|dates|time)|later|baad mein|koi bhi|pata nahi|no dates|without dates|not on (those|these)|tay nahi)(?![a-z])/i;
const hasRelativeAnchor = (message: string) => ANCHORS.some(([re]) => re.test(message));
const LENGTH = /(?<![\p{L}\p{M}\p{N}])(\d+|one|two|three|four|five|six|seven|ek|do|teen|char|chaar|paanch)\s*(nights?|raat)(?![\p{L}\p{M}\p{N}])/giu;
const LENGTH_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5 };

/** "make it 4 nights" when dates are already set: the stay keeps its check-in and
 *  lasts N nights (the last length named: "not 3 nights, make it 5"). Arithmetic, so
 *  done here; models moved the wrong end or kept the old length. Only when nothing
 *  else in the message could be a start day; otherwise the model's reading stands. */
function repairLength(message: string, p: Proposal, prev: SearchState): Proposal {
  const all = [...message.matchAll(LENGTH)];
  if (!all.length || !isRealDate(prev.checkIn)) return p;
  if (DATES_DROPPED.test(message)) return p; // "forget the dates, 4 nights is enough": nothing to rebuild
  // With the lengths taken out, a digit or a time word left ("from friday", "the 20th",
  // "next week", "5 din") could name a new start or another length: leave it to the model.
  const rest = message.replace(LENGTH, " ");
  if (WRITTEN_DATE.test(message) || hasRelativeAnchor(message) || hasDateCue(rest) || /\d/.test(rest)) return p;
  const m = all[all.length - 1]!;
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : LENGTH_WORDS[m[1]!.toLowerCase()]!;
  const readLength = p.nights === n || (p.set.checkIn !== undefined || p.set.checkOut !== undefined);
  if (!readLength || n < 1) return p;
  const set = { ...p.set, checkIn: prev.checkIn!, checkOut: addDays(prev.checkIn!, n) };
  const { nights: _n, ...other } = p;
  // the dates are replaced, not removed: an "unset dates" from the model no longer applies
  return { ...other, set, unset: p.unset.filter((u) => u !== "dates") } as Proposal;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// "jaipur ke paas": the place is Jaipur (the search API widens by itself). Only Hindi
// suffixes: an English prefix ("close to …", "around …") can be part of a stay's name.
const NEAR_AFTER = /\s+(ke\s+(paas|pass|nazdeek|najdik|najdeek|aas\s*paas|aaspaas|aas-paas))$/i;
// "X ho to accha", "X would be nice", "ideally X": the customer marked X as a nice-to-have
const SOFT_AFTER = "\\s+(ho|hai|hoga|mile|mil\\s+jaye)?\\s*(to|toh)\\s+(accha|achha|acha|badhiya|best|better|mast)|\\s+(would be nice|would be great|if possible|is a bonus|is optional)";
const SOFT_BEFORE = "(ideally|preferably|if possible|nice to have|bonus if|optional(?:ly)?)\\s+(?:(?:with|have|having|has|get|a|an|some|the|wala|wali)\\s+){0,3}";
// "it must be quiet", "shaant hona zaroori hai": a vibe the customer insists on is a must-have (golden/README)
const MUST_BEFORE = "(must|must be|has to be|needs to be|should definitely be|definitely|zaroor|zarur|bilkul)\\s+(?:(?:be|a|an|very|really|ekdum)\\s+){0,2}";
const MUST_AFTER = "\\s+(?:(?:hona|ho)\\s+)?(zaroori|zaruri|jaruri|compulsory|is a must|must hai|hi chahiye|ज़रूरी|जरूरी)";
// "… ho to accha, warna nahi chalega" = "otherwise it won't do": a must-have after all
const OTHERWISE = /(?<![a-z])(warna|varna|otherwise|or else|nahi to|nahin to)(?![a-z])/i;

/** Corrections of wording the models misread, each tied to an explicit phrase. */
function phrasing(message: string, p: Proposal, prev: SearchState): Proposal {
  const set = { ...p.set };
  let { unsupported, soft } = p;
  if (set.place) set.place = set.place.replace(NEAR_AFTER, "").trim() || set.place;

  // A length the customer typed ("teen raat", "for 3 nights") that the model left out or misread
  // ("teen raat" read as 13), while no dates exist. Not for "two to four nights" or "can't do 3 nights".
  const lengths = [...message.matchAll(LENGTH)];
  let nights = p.nights;
  if (p.intent === "search" && lengths.length === 1 && !set.checkIn && !set.checkOut && !prev.checkIn
      && !WRITTEN_DATE.test(message) && !hasRelativeAnchor(message) && !hasNegation(message)
      && !/(\d+|one|two|three|four|five|six|ek|do|teen|char|chaar|paanch)\s*(-|–|to|se|or|ya)\s*$/i.test(message.slice(0, lengths[0]!.index))) {
    const m = lengths[0]!;
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : LENGTH_WORDS[m[1]!.toLowerCase()]!;
    if (n >= 1 && !hasDateCue(message.replace(LENGTH, " "))) nights = n;
  }

  // A must-have the customer marked as nice-to-have moves to soft (never the other way). Only
  // when that label is named once, as a whole phrase: "need a balcony, a sea-facing balcony
  // would be nice" keeps the balcony a must-have.
  const lower = message.toLowerCase();
  const isSoft = (label: string) => {
    const l = esc(label.toLowerCase());
    const named = lower.match(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}-])${l}(?![\\p{L}\\p{M}\\p{N}])`, "giu"))?.length ?? 0;
    if (named !== 1 || OTHERWISE.test(message)) return false;
    return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}-])${l}(${SOFT_AFTER})`, "iu").test(lower) || new RegExp(`${SOFT_BEFORE}${l}(?![\\p{L}\\p{M}\\p{N}])`, "iu").test(lower);
  };
  const insisted = soft.filter((label) => {
    const l = esc(label.toLowerCase());
    return new RegExp(`${MUST_BEFORE}${l}(?![\\p{L}\\p{M}\\p{N}])`, "iu").test(lower) || new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${l}${MUST_AFTER}`, "iu").test(lower);
  });
  if (insisted.length) {
    soft = soft.filter((x) => !insisted.includes(x));
    unsupported = [...new Set([...unsupported, ...insisted])];
  }
  const softened = unsupported.filter(isSoft);
  if (softened.length) {
    unsupported = unsupported.filter((u) => !softened.includes(u));
    soft = [...new Set([...soft, ...softened])];
  }
  // The same for a field: "self check in ho to best", "wifi if possible".
  const flags = [["selfCheckIn", "self check-in", ["self check in", "self check-in", "self checkin", "self-check-in"]], ["instantBook", "instant book", ["instant book", "instant booking"]]] as const;
  for (const [k, label, words] of flags) {
    if (set[k] && words.some(isSoft)) { delete set[k]; soft = [...new Set([...soft, label])]; }
  }
  if (set.amenitiesAll?.length) {
    const t = tokens(message);
    const softAmenities = amenityMentions(message).filter((m) => set.amenitiesAll!.includes(m.key) && isSoft(t[m.at]!)).map((m) => m.key);
    if (softAmenities.length) {
      const rest = set.amenitiesAll.filter((a) => !softAmenities.includes(a));
      if (rest.length) set.amenitiesAll = rest;
      else delete set.amenitiesAll;
      soft = [...new Set([...soft, ...softAmenities.filter((k) => !soft.some((s) => amenitiesNamed(s).includes(k)))])]; // "bbq if possible" already there
    }
  }
  // "lake view wala room", "pool-facing", "beach view": a view is not the amenity. Listings record no views, and a
  // lakeside stay need not look at the lake. An amenity named only inside a view phrase is dropped; the view stays a
  // requirement no field can check (a nice-to-have only when the customer said so).
  const views = p.intent === "search" ? [...message.matchAll(VIEW)].map((m) => m[0].trim()) : [];
  if (views.length) {
    const named = new Set(amenityMentions(message.replace(VIEW, " ")).map((m) => m.key));
    const drop = views.flatMap((v) => amenitiesNamed(v)).filter((k) => !named.has(k));
    for (const k of ["amenitiesAll", "amenitiesAny"] as const) {
      const rest = set[k]?.filter((x) => !drop.includes(x));
      if (rest?.length) set[k] = rest;
      else delete set[k];
    }
    const same = (a: string, b: string) => a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());
    for (const v of views) {
      const inSoft = soft.filter((s) => same(s, v));
      // already a must-have, or a nice-to-have the customer marked as one ("a sea-facing balcony would be nice")
      if (unsupported.some((u) => same(u, v)) || inSoft.some(isSoft)) continue;
      if (inSoft.length) { // softened by the model with no word of the customer's saying so: a must-have, in its words
        soft = soft.filter((s) => !inSoft.includes(s));
        unsupported = [...new Set([...unsupported, ...inSoft])];
      } else if (isSoft(v)) soft = [...soft, v];
      else unsupported = [...unsupported, v];
    }
  }
  return { ...p, set, unsupported, soft, nights };
}
const VIEW = /(?<![\p{L}\p{M}])(lake|sea|beach|pool|mountain|hill|river|garden|valley|ocean|jheel)[\s-]*(view|facing)(?![\p{L}\p{M}])|(झील|समुद्र|पहाड़|पूल)\s*(का|की|के)?\s*(व्यू|नज़ारा|नजारा)/giu;
