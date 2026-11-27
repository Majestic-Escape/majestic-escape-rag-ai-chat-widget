// Reading simple messages without a model.
//
// "under 10k", "for 6 people", "with wifi", "villas in goa for 8" need no
// language model — and on free tiers every model call is scarce (a few hundred
// a day). This reader handles a message only when it can account for EVERY
// word: each piece must match a known pattern, be a filler word, or be a place
// the site's own search recognises. Anything else — a negation, a date, a
// question, another script, one unknown word — and it steps aside (returns
// null) so the model reads the message instead. It never guesses.
//
// The result is an ordinary Proposal: it goes through the same guards,
// cross-checks and merge as a model's reading.

import { amenitiesNamed } from "./guards";
import { hasDateCue, hasNegation, hasNonNightlyBudgetCue, numbersIn } from "./numbers";
import type { Range } from "./types";
import type { Proposal } from "./understand";

/** Asks the site's search whether a phrase is a place it knows. */
export type PlaceCheck = (phrase: string) => Promise<boolean>;

const NUM = String.raw`(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|hazaar|hazar|hajar|thousand|lakhs?|lacs?)?(?![a-z])`;
const one = (phrase: string): number | null => numbersIn(phrase).required[0] ?? null;

const TYPES: [RegExp, string][] = [
  [/\b(villas?|bungalows?)\b/, "villa"], [/\b(apartments?|flats?)\b/, "apartment"], [/\bhotels?\b/, "hotel"],
  [/\btents?\b/, "tent"], [/\b(guest ?houses?|homestays?)\b/, "guesthouse"], [/\bfarm ?houses?\b/, "farmhouse"], [/\bhouses?\b/, "house"],
];
const AMENITY_PHRASES =
  /\b(swimming pool|pool table|wi-?fi|wi fi|internet|free parking|car parking|parking|air[- ]?condition(?:ing|ed|er)|a\/?c|ac|kitchen|rasoi|tv|television|work ?space|work desk|desk|washing machine|washing|washer|laundry|bbq|barbe(?:c|q)ue|grill|lakeside|lake|beach ?front|beach access|beach|fire ?pit|bonfire|patio|pool|billiards|first aid|outdoor dining|smoke alarm|fire extinguisher)\b/g;
// Words that carry no requirement. Deliberately short: an unknown word must
// send the message to the model, not be skipped.
const FILLER = new Set([
  "please", "pls", "plz", "show", "me", "us", "find", "get", "give", "i", "we", "want", "need", "looking", "for", "a", "an", "the", "some",
  "stay", "stays", "place", "places", "property", "properties", "option", "options", "also", "and", "with", "having", "has", "have", "that", "which",
  "in", "at", "of", "is", "are", "be", "should", "must", "my", "our", "per", "night", "nightly", "budget", "price", "range",
  "chahiye", "chaiye", "dikhao", "dikha", "dikhaiye", "batao", "mujhe", "hume", "humein", "hamein", "ka", "ki", "ke", "ko", "wala", "wali", "wale",
  "bhi", "ho", "hona", "mein", "me", "liye", "ek", "aur", "to", "ok", "okay", "now", "then", "make", "it",
]);

// "cheaper", "isse sasta kuch hai?", "इससे सस्ता कुछ दिखाओ": with no amount, no requirement
// changes and the wish is noted (golden/README). A model answered these with "{}".
const CHEAPER = new Set(["cheaper", "sasta", "saste", "sasti", "सस्ता", "सस्ते", "सस्ती"]);
const CHEAPER_FILLER = new Set(["something", "anything", "any", "kuch", "koi", "isse", "usse", "se", "thoda", "thodi", "one", "ones", "hai", "hain", "milega", "milegi", "less", "expensive",
  "इससे", "उससे", "कुछ", "कोई", "दिखाओ", "है", "हैं", "चाहिए", "और", "थोड़ा", "थोड़ी", "बताओ", "मिलेगा"]);
function cheaperOnly(message: string): Proposal | null {
  const words = message.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  if (!words.length || words.length > 8 || !words.some((w) => CHEAPER.has(w) || w === "expensive")) return null;
  if (/\d/.test(message) || words.some((w) => !CHEAPER.has(w) && !CHEAPER_FILLER.has(w) && !FILLER.has(w))) return null;
  if (words.includes("expensive") && !words.includes("less")) return null; // "something expensive" is not cheaper
  return { intent: "search", reset: false, set: {}, unset: [], remove: [], soft: ["cheaper"], unsupported: [], priceBasis: "night", target: { ordinals: [], names: [] }, ask: [] };
}

export async function quickRead(message: string, isPlace: PlaceCheck): Promise<Proposal | null> {
  const cheaper = cheaperOnly(message);
  if (cheaper) return cheaper;
  const original = message.trim();
  // Out of scope: anything not plainly a short list of requirements.
  if (original.length > 140 || /[?]/.test(original) || /[^\x00-\x7F₹]/.test(original)) return null;
  let s = ` ${original.toLowerCase().replace(/[,;!.]+(?=\s|$)/g, " ")} `;
  if (hasNegation(s) || hasNonNightlyBudgetCue(s)) return null;
  // "per night" is the budget's unit, not a date.
  s = s.replace(/\b(per|a|each|\/)\s*(night|raat)\b|\bpn\b|\bek raat\b/g, " ");
  if (hasDateCue(s)) return null;

  const set: Proposal["set"] = {};
  let ok = true;
  const take = (re: RegExp, use: (m: RegExpMatchArray) => void) => {
    s = s.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      use(m);
      return " ";
    });
  };
  const range = (field: "bedrooms" | "beds" | "bathrooms" | "guests" | "price", r: Range) => {
    if (set[field]) ok = false; // the same thing said twice: let the model read it
    set[field] = { ...set[field], ...r };
  };
  const num = (phrase: string | undefined): number => {
    const n = phrase ? one(phrase) : null;
    if (n === null || n < 1) ok = false;
    return n ?? 0;
  };

  // rooms — before the budget, so "at least 3 bedrooms" is not read as a price
  for (const [field, word] of [["bedrooms", String.raw`(?:bedrooms?|bhk|br)`], ["bathrooms", String.raw`(?:bathrooms?|baths?)`], ["beds", String.raw`beds?`]] as const) {
    take(new RegExp(String.raw`\b(exactly|only|just|sirf)\s+(\d{1,2})\s*-?\s*${word}\b`, "g"), (m) => range(field, { min: Number(m[2]), max: Number(m[2]) }));
    take(new RegExp(String.raw`\b(?:(?:at ?least|minimum|min)\s+)?(\d{1,2})\s*-?\s*${word}\b`, "g"), (m) => range(field, { min: Number(m[1]) }));
  }
  // guests
  take(/\b(\d{1,2})\s*adults?\s*(?:and|&|\+|,)?\s*(\d{1,2})\s*(?:kids?|children|child|bachche)\b/g, (m) => range("guests", { min: Number(m[1]) + Number(m[2]) }));
  take(/\b(\d{1,2})\s*(?:guests?|people|persons?|adults?|pax|log|logon|logo|bande|members|of us)\b/g, (m) => range("guests", { min: Number(m[1]) }));
  take(/\b(?:for|we are|we're)\s+(\d{1,2})\b(?!\s*(?:k\b|hazaar|hazar|thousand|lakh|,|\d))/g, (m) => range("guests", { min: Number(m[1]) }));
  // budget
  take(new RegExp(String.raw`\b(?:above|over|at ?least|minimum|min|more than|from)\s+(${NUM})`, "g"), (m) => range("price", { min: num(m[1]) }));
  take(new RegExp(String.raw`(${NUM})\s*(?:se zyada|se upar|se adhik)\b`, "g"), (m) => range("price", { min: num(m[1]) }));
  take(new RegExp(String.raw`\b(?:under|below|within|upto|up to|max|maximum|less than|budget(?: is| of)?)\s+(${NUM})`, "g"), (m) => range("price", { max: num(m[1]) }));
  take(new RegExp(String.raw`(${NUM})\s*(?:tak|ke andar|se kam|ke neeche|max)\b`, "g"), (m) => range("price", { max: num(m[1]) }));
  // amenities
  const named = amenitiesNamed(s);
  if (named.length) {
    set.amenitiesAll = named;
    s = s.replace(AMENITY_PHRASES, " ");
  }
  // place type, then property type
  take(/\b(entire|whole|full)\s+(place|villa|house|home|property|apartment|flat)\b/g, (m) => {
    set.placeType = "entire";
    if (m[2] !== "place" && m[2] !== "home" && m[2] !== "property") s += ` ${m[2]} `; // "entire villa" is also a villa
  });
  take(/\b(private room|a room|single room|rooms?|kamra|kamre)\b/g, () => { set.placeType = "room"; });
  for (const [re, type] of TYPES) {
    if (re.test(s)) {
      if (set.propertyType && set.propertyType !== type) ok = false; // "villa or apartment": the model's job
      set.propertyType = type;
      s = s.replace(new RegExp(re.source, "g"), " ");
    }
  }

  // Whatever is left must be filler — or one place name the site recognises.
  const rest = s.split(/\s+/).filter((w) => w && !FILLER.has(w));
  if (rest.some((w) => /\d/.test(w))) return null; // a number we did not place
  if (rest.length > 0) {
    if (rest.length > 3) return null;
    const phrase = rest.join(" ");
    if (!/^[a-z][a-z .'-]*$/.test(phrase) || !(await isPlace(phrase))) return null;
    set.place = phrase;
  }
  if (!ok || Object.keys(set).length === 0) return null;
  return { intent: "search", reset: false, set, unset: [], remove: [], soft: [], unsupported: [], priceBasis: "night", target: { ordinals: [], names: [] }, ask: [] };
}
