// Questions about, and comparisons of, stays the customer has already been
// shown ("does the second one have parking?", "compare the first two").
// Answered from the listing's own fields, re-fetched this turn — templates only.
// A field the listing does not carry is reported as not stated, never guessed.

import { fetchCandidates, type CatalogDeps } from "./catalog";
import type { Listing, SearchState } from "./types";
import type { Askable, Proposal } from "./understand";

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const RULES: Record<string, string> = { no_parties: "no parties", quiet_hours: "quiet hours", no_smoking: "no smoking", no_pets: "no pets" };
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type InquiryReply = { kind: "answer"; text: string } | { kind: "which" } | { kind: "unavailable" };

function fact(l: Listing, ask: Askable, availability: "available" | "unavailable" | "unverified" | "no_dates"): string {
  switch (ask) {
    case "price":
      return num(l.basePrice) ? `${inr(l.basePrice)} a night, before taxes and fees` : "price not stated on the listing";
    case "capacity": {
      const parts = [
        num(l.guests) ? `sleeps ${l.guests}` : null,
        num(l.bedrooms) ? `${l.bedrooms} ${l.bedrooms === 1 ? "bedroom" : "bedrooms"}` : null,
        num(l.beds) ? `${l.beds} ${l.beds === 1 ? "bed" : "beds"}` : null,
        num(l.bathrooms) ? `${l.bathrooms} ${l.bathrooms === 1 ? "bathroom" : "bathrooms"}` : null,
      ].filter(Boolean);
      return parts.length ? parts.join(", ") : "capacity not stated on the listing";
    }
    case "amenities":
      return Array.isArray(l.amenities) && l.amenities.length ? `amenities listed: ${l.amenities.join(", ")}` : "no amenities are listed";
    case "checkin":
      return l.checkinTime || l.checkoutTime
        ? [l.checkinTime ? `check-in ${l.checkinTime}` : null, l.checkoutTime ? `check-out ${l.checkoutTime}` : null].filter(Boolean).join(", ")
        : "check-in and check-out times are not stated on the listing";
    case "cancellation": {
      const c = l.cancellationType;
      const kind = c?.flexible ? "flexible" : c?.moderate ? "moderate" : c?.strict ? "strict" : null;
      return kind ? `${kind} cancellation (the terms are on its page)` : "cancellation terms are not stated on the listing";
    }
    case "rules":
      return Array.isArray(l.selectedRules) && l.selectedRules.length
        ? `house rules: ${l.selectedRules.map((r) => RULES[r] ?? r.replace(/_/g, " ")).join(", ")}`
        : "no house rules are listed";
    case "location": {
      const where = [l.address?.district, l.address?.city, l.address?.state].filter((x, i, a) => x && a.indexOf(x) === i);
      return where.length ? `in ${where.join(", ")}` : "location not stated on the listing";
    }
    case "availability":
      return availability === "available"
        ? "available for your dates when checked just now, confirmed at checkout"
        : availability === "unavailable"
        ? "unavailable for your selected dates"
        : availability === "unverified"
        ? "unable to verify availability right now"
        : "select dates to check availability";
  }
}

const SUMMARY: Askable[] = ["price", "capacity", "location"];
const COMPARE: Askable[] = ["price", "capacity", "cancellation"];

const AMENITY_WORD = /\b(kitchen|pool|wi-?fi|internet|parking|air[- ]?condition\w*|ac|tv|television|bbq|barbe?cue|grill|washing|washer|laundry|workspace|desk|beach|lake|fire ?pit|bonfire|patio|first aid|smoke alarm|fire extinguisher|amenit\w*|facilit\w*|suvidha)\b|रसोई|किचन|पूल|पार्किंग|वाई-?फाई/i;

const ORDINALS = [
  /\b(first|1st|pehl[aei]|pahl[aei])\b|पहल[ाेी]/i,
  /\b(second|2nd|d[ou]osr[aei]|dusr[aei])\b|दूसर[ाेी]/i,
  /\b(third|3rd|t[ie]esr[aei]|tisr[aei])\b|तीसर[ाेी]/i,
];

export async function inquire(p: Proposal, state: SearchState, deps: CatalogDeps, signal: AbortSignal, message = ""): Promise<InquiryReply> {
  const shown = state.shownIds ?? [];
  const byName = p.target.names[0];
  // Which stays? Ordinals point into the last reply; a name is looked up; a lone shown stay is "it".
  // the model left out the stay it was asked about ("दूसरे वाले में पार्किंग है?"): read the ordinal word
  const ordinals = p.target.ordinals.length || byName ? p.target.ordinals : ORDINALS.flatMap((re, i) => (re.test(message) ? [i + 1] : []));
  let ids = ordinals.map((n) => shown[n - 1]).filter((x): x is string => !!x);
  if (ordinals.length > 0 && ids.length !== ordinals.length) return { kind: "which" };
  if (ids.length === 0 && !byName && shown.length === 1) ids = [shown[0]!];
  if (ids.length === 0 && !byName && p.intent === "compare" && shown.length >= 2) ids = shown.slice(0, 3);
  if (ids.length === 0 && !byName) return { kind: "which" };

  // Fresh data: the same search the cards came from, without dates (so a stay that is
  // booked for the dates is still found), or the name lookup.
  const undated = await fetchCandidates({ place: byName && ids.length === 0 ? byName : state.place }, deps, signal);
  if (undated.kind !== "ok") return { kind: "unavailable" };
  const rows =
    ids.length > 0
      ? ids.map((id) => undated.rows.find((r) => r._id === id)).filter((r): r is Listing => !!r)
      : undated.scope === "name" ? undated.rows.slice(0, 3) : [];
  if (rows.length === 0) return { kind: "which" };

  const base: Askable[] = p.ask.length ? p.ask : p.intent === "compare" ? COMPARE : SUMMARY;
  // "does the second one have a kitchen?": answered with the amenities even if the reading did not ask for them
  const asks: Askable[] = AMENITY_WORD.test(message) && !base.includes("amenities") ? [...base, "amenities"] : base;
  let free: Set<string> | null = null;
  let complete = true;
  if (asks.includes("availability") && state.checkIn && state.checkOut) {
    const dated = await fetchCandidates({ place: byName && ids.length === 0 ? byName : state.place, checkIn: state.checkIn, checkOut: state.checkOut }, deps, signal);
    if (dated.kind !== "ok") return { kind: "unavailable" };
    free = new Set(dated.rows.map((r) => r._id));
    complete = dated.complete; // a stay missing from a capped search is not "unavailable"
  }
  const lines = rows.slice(0, 3).map((l) => {
    const a = free ? (free.has(l._id) ? "available" : complete ? "unavailable" : "unverified") : "no_dates";
    const facts = asks.map((x) => fact(l, x, a));
    return `${l.title ?? "This stay"}: ${facts.join("; ")}.`;
  });
  return { kind: "answer", text: lines.join("\n") };
}
