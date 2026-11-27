// Finds the numbers a customer actually typed, so the model's reading of a
// message can be checked against it (understand.ts → crossCheck). The model's
// JSON is a proposal; a number it invents, or one it silently drops, must not
// reach the search.
//
// Two classes:
//  • required — digits ("8", "₹10,000", "10k", "1.5 lakh", "४") and a number
//    word with a multiplier ("das hazaar", "ten thousand"). Unambiguous: each
//    one must be used by the reading.
//  • optional — bare number words ("two", "do", "aath", "couple"). They can
//    justify an extracted number but need not be used: "do" is also English.

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/** What a model provider is sent in place of contact details a customer typed.
 *  Only e-mail addresses and phone numbers (10+ digits) — never amounts: the
 *  largest budget anyone types is far shorter than a phone number. */
export function redactForModel(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/g, "<phone>")
    .replace(/\+?\d[\d\s-]{10,}\d/g, (m) => (m.replace(/\D/g, "").length >= 11 ? "<phone>" : m));
}

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, twenty: 20,
  thirty: 30, forty: 40, fifty: 50,
  // Hindi, Latin script
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, che: 6,
  saat: 7, sat: 7, aath: 8, aat: 8, ath: 8, nau: 9, das: 10, dus: 10, gyarah: 11, barah: 12,
  pandrah: 15, bees: 20, pachees: 25, tees: 30, pachaas: 50, pachas: 50,
  // Hindi, Devanagari
  "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पांच": 5, "पाँच": 5, "छह": 6, "छः": 6, "सात": 7, "आठ": 8,
  "नौ": 9, "दस": 10, "बारह": 12, "पंद्रह": 15, "बीस": 20, "पचास": 50,
  // people words
  couple: 2, solo: 1, single: 1,
};

const MULTIPLIERS: Record<string, number> = {
  k: 1_000, thousand: 1_000, hazaar: 1_000, hazar: 1_000, hajar: 1_000, hajaar: 1_000, "हज़ार": 1_000, "हजार": 1_000,
  lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, "लाख": 100_000,
};

const MULT = Object.keys(MULTIPLIERS).join("|");
const WORD = Object.keys(WORDS).join("|");
// Devanagari has no \b in JS regex, so boundaries are spelled out. Vowel signs are \p{M}:
// without it "मत" (don't) was found inside "कीमत" (price) and "एक" inside "एकांत".
const B0 = "(?<![\\p{L}\\p{M}\\p{N}])";
const B1 = "(?![\\p{L}\\p{M}\\p{N}])";

export interface Numbers {
  required: number[];
  optional: number[];
}

export function numbersIn(raw: string): Numbers {
  let text = raw.toLowerCase();
  text = text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  // 10,000 and 1,00,000 are one number; "24,25 dec" is two. A grouped number always ends in three digits.
  text = text.replace(/\d{1,3}(?:,\d{2,3})*,\d{3}(?!\d)/g, (m) => m.replace(/,/g, ""));

  const required: number[] = [];
  const optional: number[] = [];
  const spent: [number, number][] = [];
  const take = (m: RegExpMatchArray) => spent.push([m.index!, m.index! + m[0].length]);
  const free = (m: RegExpMatchArray) => !spent.some(([a, b]) => m.index! < b && m.index! + m[0].length > a);

  // A child's age ("7 saal ka", "5 year old", "3 yrs") is never a requirement: set it aside.
  const age = new RegExp(`${B0}(\\d+|${WORD})\\s*-?\\s*(saal|sal|years?|yrs?|साल|वर्ष)${B1}`, "gu");
  for (const m of text.matchAll(age)) take(m);
  // "8-10k", "8 to 10 lakh": the multiplier belongs to both ends.
  // "between 5 and 8 thousand" too ("and" only after "between": "for 2 and 15k" is two numbers)
  const range = new RegExp(`(?:between\\s+)?(\\d+(?:\\.\\d+)?)\\s*(?:-|–|to|se|(?<=between\\s+\\d+(?:\\.\\d+)?\\s*)and)\\s*(\\d+(?:\\.\\d+)?)\\s*(${MULT})${B1}`, "giu");
  for (const m of text.matchAll(range)) {
    const x = MULTIPLIERS[m[3]!]!;
    required.push(Math.round(Number(m[1]) * x), Math.round(Number(m[2]) * x));
    take(m);
  }
  // digits, with an optional multiplier: "10k", "10 hazaar", "1.5 lakh", "4bhk" (→ 4)
  const digits = new RegExp(`(\\d+(?:\\.\\d+)?)(?:\\s*(${MULT})${B1})?`, "gu");
  for (const m of text.matchAll(digits)) {
    if (!free(m)) continue;
    take(m);
    if (m[1]!.replace(".", "").length > 9) continue; // a phone number, not a requirement
    required.push(Math.round(Number(m[1]) * (m[2] ? MULTIPLIERS[m[2]]! : 1)));
  }
  // number word + multiplier: "das hazaar", "ten thousand", "दस हज़ार"
  const worded = new RegExp(`${B0}(${WORD})\\s+(${MULT})${B1}`, "gu");
  for (const m of text.matchAll(worded)) {
    if (!free(m)) continue;
    take(m);
    required.push(WORDS[m[1]!]! * MULTIPLIERS[m[2]!]!);
  }
  const bare = new RegExp(`${B0}(${WORD})${B1}`, "gu");
  for (const m of text.matchAll(bare)) {
    if (free(m)) optional.push(WORDS[m[1]!]!);
  }
  return { required, optional };
}

// A digit alone is not a time word ("for 4 people"); a written date is ("24/12", "24-12").
const DATE_CUE = new RegExp(
  `\\d{1,2}\\s*[/-]\\s*\\d{1,2}|${B0}(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|` +
    `mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|` +
    `today|tonight|tomorrow|weekend|week|month|night|nights|days?|christmas|xmas|new year|diwali|holi|eid|` +
    `aaj|kal|parso|parson|agle|agla|hafte|hafta|mahine|mahina|raat|din|` +
    `आज|कल|परसों|हफ्ते|हफ़्ते|महीने|रात|दिन|वीकेंड|वीकएंड|सप्ताहांत|शनिवार|रविवार|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|तारीख|` +
    `जनवरी|फरवरी|फ़रवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|सितम्बर|अक्टूबर|नवंबर|नवम्बर|दिसंबर|दिसम्बर)${B1}`,
  "iu"
);
/** Does the message mention time at all? Dates may only be set from a message that does. */
export const hasDateCue = (text: string) => DATE_CUE.test(text);

const NEGATION = new RegExp(
  `${B0}(no|not|without|except|excluding|don'?t|dont|doesn'?t|can'?t|cannot|won'?t|isn'?t|aren'?t|didn'?t|remove|drop|skip|minus|never|nahi|nahin|nhi|mat|bina|hatao|hata|नहीं|बिना|मत)${B1}`,
  "iu"
);
// Negations that carry no requirement.
// "wifi is a must, can't do without it" insists on a requirement; it negates nothing
const NEGATION_NOISE = /\b(no problem|not sure|no idea|why not|not yet|no worries|not too|no thanks|no thank you|if not|(can['’]?t|cannot|can not) (do|live|go|manage) without)\b/giu;
// "budget ka pata nahi" = "don't know yet": no requirement is negated.
// "paisa koi issue nahi" = money is no issue: relaxes, negates nothing the customer wants
const NEGATION_NOISE_HI = /(pata|maloom|malum)\s+(nahi|nahin|nhi)|पता\s+नहीं|मालूम\s+नहीं|(koi\s+)?(issue|problem|dikkat|tension|chinta|farak|fark)\s+(nahi|nahin|nhi)|(कोई\s+)?(दिक्कत|समस्या|परेशानी|फर्क|फ़र्क|टेंशन)\s+नहीं/giu;
export const hasNegation = (text: string) => NEGATION.test(text.replace(NEGATION_NOISE, " ").replace(NEGATION_NOISE_HI, " "));

// "total 8 people" and "2 bedrooms each" are not about money, so "total" and
// "each" count only next to budget wording; "30k for 3 nights" is a total.
const NON_NIGHTLY = new RegExp(
  `${B0}(per person|per head|per guest|pp|a head|in total|total (budget|cost|price|amount)|(budget|cost|price) (in )?total|overall|altogether|` +
    `whole (stay|trip|week|holiday|vacation)|entire (stay|trip|week)|for the (whole |entire )?(stay|trip|weekend|week)|sab mila ?ke|kul (budget|kharcha)|per week|weekly|per month|monthly|` +
    `poore (trip|safar|stay|week)|pure (trip|safar)|prati vyakti|per vyakti|प्रति व्यक्ति|पूरे (ट्रिप|सफ़र|सफर|हफ्ते)|कुल (बजट|खर्च))${B1}` +
    `|\\d\\s*(k|rs|rupees|inr|hazaar|hazar|lakh)?\\s*(each|total|for\\s*\\d+\\s*(nights?|days?|raat|din))${B1}`,
  "iu"
);
/** The budget is worded as something other than a nightly rate. */
export const hasNonNightlyBudgetCue = (text: string) => NON_NIGHTLY.test(text);

// "15 hazaar se zyada nahi", "isse zyada nahi", "not more than": a bound, not a negation
const NAHI = "(?:nahi|nahin|nhi|na|nai|नहीं|ना)";
const BOUND_FILLER = "(?:\\s+(?:mehe?nga|mahe?nga|costly|expensive|ka|ki|ke|wala|wali|hona|ho|budget|महंगा|मंहगा|का|की|के))*";
export const BOUND_NEGATION = new RegExp(
  `${B0}(?:(?:se|isse|usse|is se|us se)\\s+(?:zyada|jyada|upar|adhik|kam)${BOUND_FILLER}\\s+${NAHI}(?:\\s+(?:chahiye|hona chahiye|ho))?|` +
    `(?:से|इससे|उससे)\\s+(?:(?:ज़|ज़?)्यादा|ऊपर|अधिक|कम)${BOUND_FILLER}\\s+${NAHI}|(?:not|no)\\s+(?:more|less|over|above|under|below)(?:\\s+than)?)${B1}`,
  "giu"
);
/** A negation about a requirement (bounds such as "not more than 5000" excluded). */
export const negatesSomething = (text: string) => hasNegation(text.replace(BOUND_NEGATION, " "));

// People added to the group: "one more (friend)", "ek aur dost", "2 more people", "2 bacche bhi",
// "ek dost aur aa raha hai", "my brother is also coming".
const PEOPLE = "friends?|dost|people|persons?|guests?|adults?|kids?|child|children|bacche|bachche|baccha|bachcha|log|logon|bande|members?|लोग|बच्चे|दोस्त";
const COUNT = "\\d+|one|two|three|four|five|ek|do|teen|char|chaar|paanch|एक|दो|तीन|चार";
const ADDED_PEOPLE = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{N}])(?:(${COUNT})\s+(?:more|aur|extra|additional|और)(?:\s+(?:${PEOPLE}))?|(${COUNT})\s+(?:${PEOPLE})\s+(?:bhi|also|too|भी)|(${COUNT})\s+(?:${PEOPLE})\s+(?:aur|और|more)\s+(?:aa|आ|join|coming|come)|((?:my|meri|mera|mere|hamara|hamari)\s+(?:wife|husband|partner|brother|sister|friend|mom|dad|son|daughter|bhai|behen|dost|beta|beti|parents|mummy papa)\s+(?:is\s+|are\s+)?(?:also\s+|bhi\s+)?(?:joining|coming|aa raha|aa rahi|aa rahe)))(?![\p{L}\p{M}])`,
  "giu"
);
/** How many people each "joining" phrase adds (NaN when its count is not a number). */
export function peopleAdded(message: string): number[] {
  return [...message.toLowerCase().matchAll(ADDED_PEOPLE)].map((m) => {
    if (m[4]) return /parents|mummy papa/i.test(m[4]) ? 2 : 1;
    const k = numbersIn(m[1] ?? m[2] ?? m[3]!);
    return k.required[0] ?? k.optional[0] ?? NaN;
  });
}

// ── the size of the group the customer described ─────────────────────────────
// golden/README: guests = adults + children, infants not counted; "2 couples" = 4.
const N_ = `(\\d+|${WORD})`;
const TOTAL_WORDS = "people|persons?|guests?|pax|log|logon|logo|लोग|लोगों|members|travell?ers|of us";
const PART_WORDS = "adults?|grown[- ]?ups?|bade|bado|बड़े|बडे|men|women|ladies|gents|boys|girls|friends|dost|doston|दोस्त|bande|seniors?|elders?|kids?|child(?:ren)?|bacch?e|bachche|bacch?a|bachcha|बच्चे|बच्चा|teens?|teenagers?";
const KID_SG = "son|daughter|kid|child|boy|girl|beta|beti|baccha|bachcha|बेटा|बेटी|बच्चा";
const INFANT_WORDS = "bab(?:y|ies)|infants?|newborns?|toddlers?|शिशु";
const PERSON_SG = "wife|husband|partner|girlfriend|boyfriend|fiance|fiancee|mom|mother|mum|mummy|dad|father|papa|son|daughter|brother|sister|friend|colleague|biwi|patni|pati|beta|beti|bhai|behen|bahan|dost|maa|ammi|बेटा|बेटी|पत्नी|पति|भाई|बहन|दोस्त|माँ|मां";
const POSSESSIVE = "my|meri|mera|mere|our|hamari|hamara|humari|apni|apna|मेरी|मेरा|मेरे|हमारी|हमारा";
/** Words that say the number is unknown ("family with 2 kids", "me and my friends"): no arithmetic. */
const UNCOUNTED = new RegExp(`${B0}(famil(?:y|ies)|parivar|परिवार|group|friends|dost log|kids|children|bacche|बच्चे)${B1}`, "iu");

export interface Headcount { total: number; infants: number; consumed: number[] }

/** The guests a message describes part by part ("2 adults and a 6 year old" = 3, "me, my wife and our
 *  2 kids" = 4, "2 couples" = 4, "main akela hoon" = 1). null when the message states a total itself
 *  ("4 log"), or names people without a count ("family with 2 kids"). */
export function headcount(raw: string): Headcount | null {
  let text = raw.toLowerCase().replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  if (new RegExp(`${B0}${N_}\\s*(?:${TOTAL_WORDS})${B1}|(?:family|group) of\\s+${N_}`, "iu").test(text)) return null;
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORDS[s] ?? NaN);
  const spent: [number, number][] = [];
  const hit = (re: RegExp, f: (m: RegExpMatchArray) => void) => {
    for (const m of text.matchAll(re)) {
      const a = m.index!, b = a + m[0].length;
      if (spent.some(([x, y]) => a < y && b > x)) continue;
      spent.push([a, b]);
      f(m);
    }
  };
  let total = 0, infants = 0, people = 0, withSelf = false;
  const consumed: number[] = [];
  // a baby's age in months, with or without the word: an infant
  hit(new RegExp(`${B0}(\\d+)\\s*-?\\s*(?:months?|mahine|mahina|महीने|महीना)(?:\\s*-?\\s*old)?(?:\\s*(?:ka|ki|ke|का|की|के))?(?:\\s+(?:${KID_SG}|${INFANT_WORDS}))?${B1}`, "giu"), (m) => { infants++; consumed.push(Number(m[1])); });
  // "a 6 year old", "10 saal ka beta": one child (an infant under 2)
  hit(new RegExp(`${B0}(?:(?:a|an|one|ek|our|my|${POSSESSIVE})\\s+)?(\\d+)\\s*-?\\s*(?:years?|yrs?|saal|sal|साल)(?:\\s*-?\\s*old)?(?:\\s*(?:ka|ki|ke|का|की|के))?(?:\\s+(${KID_SG}))?${B1}`, "giu"), (m) => {
    const article = /^(a|an|one|ek|our|my|meri|mera|mere|hamari|hamara|humari|apni|apna|मेरी|मेरा|मेरे|हमारी|हमारा)\s/i.test(m[0]);
    if (!article && !m[2]) return; // "aged 5 and 7 years": ages of children already counted
    if (Number(m[1]) < 2) infants++; else { total++; people++; }
  });
  hit(new RegExp(`${B0}(?:${N_}\\s+)?(?:${INFANT_WORDS})${B1}`, "giu"), (m) => { infants += m[1] ? num(m[1]) : 1; if (m[1] && /^\d+$/.test(m[1])) consumed.push(Number(m[1])); });
  hit(new RegExp(`${B0}${N_}\\s+couples?${B1}`, "giu"), (m) => { total += 2 * num(m[1]!); people++; if (/^\d+$/.test(m[1]!)) consumed.push(Number(m[1])); });
  hit(new RegExp(`${B0}(?:a|one|ek)\\s+couple${B1}(?!\\s+of)`, "giu"), () => { total += 2; people++; });
  hit(new RegExp(`${B0}${N_}\\s+famil(?:y|ies)${B1}`, "giu"), (m) => { if (/^\d+$/.test(m[1]!)) consumed.push(Number(m[1])); });
  hit(new RegExp(`${B0}${N_}\\s+(?:(?:chhote|chote|chhoti|small|little|young|छोटे)\\s+)?(?:${PART_WORDS})${B1}`, "giu"), (m) => { total += num(m[1]!); people++; if (/^\d+$/.test(m[1]!)) consumed.push(Number(m[1])); });
  hit(new RegExp(`${B0}(?:with\\s+)?(?:${POSSESSIVE})\\s+(?:${PERSON_SG})${B1}`, "giu"), (m) => { total++; people++; if (/^with\s/i.test(m[0])) withSelf = true; });
  hit(new RegExp(`${B0}my parents${B1}|${B0}(?:mere|meri) (?:mummy papa|maa baap|parents)${B1}`, "giu"), () => { total += 2; people++; });
  // the customer themself, only when listed with others ("for me, my wife…", "main aur meri wife")
  const self = new RegExp(`(?:${B0}(?:mere|hamare)\\s+(?:saath|sath)${B1}|मेरे\\s+साथ|${B0}(?:for|with|just|only|sirf)\\s+(?:me|myself)${B1}|^\\s*(?:me|myself)\\s*[,&]|${B0}(?:me|myself|main|mai|मैं)\\s+(?:and|aur|&|और)\\s)`, "iu").test(text);
  if (Number.isNaN(total)) return null;
  // what is left after the counted phrases must not name more people we cannot count
  const rest = spent.sort((a, b) => b[0] - a[0]).reduce((s, [a, b]) => s.slice(0, a) + " ".repeat(b - a) + s.slice(b), text);
  if (UNCOUNTED.test(rest)) return null;
  if (people > 0 && (self || withSelf)) total++;
  if (people === 0) {
    if (new RegExp(`${B0}(alone|solo|akela|akeli|akele|अकेला|अकेली|अकेले|by myself|just me|only me|sirf main|sirf mai)${B1}`, "iu").test(text)) return { total: 1, infants, consumed };
    return total > 0 ? { total, infants, consumed } : null;
  }
  return total > 0 ? { total, infants, consumed } : null;
}
