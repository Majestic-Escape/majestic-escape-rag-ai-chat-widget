// Every customer-visible word of a search reply is written here, by code, from
// the evidence. No model text. `validateReply` then re-checks the finished
// reply against the evidence before it is sent (the last line of defence
// against a template bug, not against a model).

import type { CatalogResult } from "./catalog";
import { formatDates } from "./dates";
import { consentSignature, type Decision } from "./requirements";
import type { Pending } from "./state";
import type { AmenityKey, Evaluated, Listing, SearchState } from "./types";
import type { ClarifyReason, PolicyTopic, Unsettable } from "./understand";

export const MAX_CARDS = 8;

export type Outcome =
  | "matches" | "possible_ask" | "possible_shown" | "no_match" | "nearby" | "nearby_none"
  | "unrecognised_place" | "name_not_found" | "incomplete" | "unavailable" | "need_details"
  | "clarify" | "not_processed" | "busy" | "retry" | "greeting" | "thanks" | "reset" | "declined"
  | "policy" | "support" | "travel_off" | "other" | "safe" | "info" | "which_stay" | "draft" | "use_filters";

export interface Card {
  _id: string;
  title: string;
  propertyType: string;
  address: { city: string; state: string };
  basePrice: number;
  averageRating: number;
  reviewCount: number;
  photos: string[];
  /** absent when the listing has no value: unknown is never shown as 0 */
  guests?: number;
  bedrooms?: number;
  /** A reply never mixes groups: every card of one reply has the same one. */
  group: "match" | "possible" | "alternative";
  note?: string;
  /** Present only when a dated search in THIS turn returned the stay. */
  availability?: "available";
}

export interface Reply {
  text: string;
  cards: Card[];
  outcome: Outcome;
  pending: Pending | null;
  /** Search replies only: the requirements as chips, and the exact line of `text` that says the same. */
  chips?: Chip[];
  chipsLine?: string;
  /** Filters mode: what a typed message would change, applied only when the guest confirms. */
  draft?: Draft;
}

/** A filter operation sent by the widget: a button, an edit, or a confirmed draft line. Applied without a model. */
export interface FilterOp {
  set?: Partial<Pick<SearchState, "place" | "guests" | "bedrooms" | "beds" | "bathrooms" | "price" | "propertyType" | "placeType" | "amenitiesAll" | "amenitiesAny" | "amenitiesNone" | "petsAllowed" | "instantBook" | "selfCheckIn" | "cancellation">>;
  unset?: Unsettable[];
  remove?: string[];
  unsupported?: string[];
  soft?: string[];
  reset?: true;
}
export interface DraftLine {
  kind: "reset" | "add" | "change" | "remove" | "unverified" | "soft";
  label: string;
  op: FilterOp;
}
export interface Draft {
  /** The guest's message, as typed. */
  said: string;
  lines: DraftLine[];
  /** Things the guest should check or resolve; never applied by themselves. */
  notes: string[];
}

const SCALARS = ["place", "guests", "price", "bedrooms", "beds", "bathrooms", "propertyType", "placeType", "petsAllowed", "instantBook", "selfCheckIn", "cancellation"] as const;
/** The change from `prev` to `next`, one line per requirement, each with the operation that makes exactly that change. */
export function draftOf(said: string, prev: SearchState, next: SearchState, reset: boolean, notes: string[], today: string): Draft {
  const lines: DraftLine[] = [];
  const label = (s: SearchState) => filterChips(s, today).map((c) => c.label).join(" · ");
  if (reset && label(prev)) lines.push({ kind: "reset", label: `Start a new search (clears ${label(prev)})`, op: { reset: true } });
  const base = reset ? {} : prev;
  for (const k of SCALARS) {
    const a = label({ [k]: base[k] } as SearchState), b = label({ [k]: next[k] } as SearchState);
    if (a === b) continue;
    if (!b) lines.push({ kind: "remove", label: `Remove ${a}`, op: { unset: [k] } });
    else lines.push({ kind: a ? "change" : "add", label: a ? `Change ${a} to ${b}` : `Add ${b}`, op: { unset: [k], set: { [k]: next[k] } as FilterOp["set"] } });
  }
  const items = (k: "amenitiesAll" | "amenitiesNone" | "unsupported" | "soft") => [new Set(base[k] ?? []), new Set(next[k] ?? [])] as const;
  const [allA, allB] = items("amenitiesAll");
  for (const x of allB) if (!allA.has(x)) lines.push({ kind: "add", label: `Add ${x}`, op: { set: { amenitiesAll: [x as AmenityKey] } } });
  for (const x of allA) if (!allB.has(x)) lines.push({ kind: "remove", label: `Remove ${x}`, op: { remove: [x] } });
  const anyA = (base.amenitiesAny ?? []).join(" or "), anyB = (next.amenitiesAny ?? []).join(" or ");
  if (anyA !== anyB) lines.push(anyB
    ? { kind: anyA ? "change" : "add", label: anyA ? `Change ${anyA} to ${anyB}` : `Add ${anyB}`, op: { set: { amenitiesAny: next.amenitiesAny } } }
    : { kind: "remove", label: `Remove ${anyA}`, op: { remove: base.amenitiesAny } });
  const [noA, noB] = items("amenitiesNone");
  for (const x of noB) if (!noA.has(x)) lines.push({ kind: "add", label: `Add no ${x}`, op: { set: { amenitiesNone: [x as AmenityKey] } } });
  for (const x of noA) if (!noB.has(x)) lines.push({ kind: "remove", label: `Remove no ${x}`, op: { remove: [x] } });
  const [unA, unB] = items("unsupported");
  for (const x of unB) if (!unA.has(x)) lines.push({ kind: "unverified", label: `Add "${x}" (not checkable)`, op: { unsupported: [x] } });
  for (const x of unA) if (!unB.has(x)) lines.push({ kind: "remove", label: `Remove "${x}"`, op: { remove: [x] } });
  const [softA, softB] = items("soft");
  for (const x of softB) if (!softA.has(x)) lines.push({ kind: "soft", label: `Nice to have: ${x} (not a filter)`, op: { soft: [x] } });
  for (const x of softA) if (!softB.has(x)) lines.push({ kind: "remove", label: `Remove nice-to-have ${x}`, op: { remove: [x] } });
  return { said, lines, notes };
}

/** The same draft as plain text: for history, old bundles and screen readers. */
export const draftText = (d: Draft): string =>
  [d.lines.length ? "Changes to apply:" : "No change to your search found in that.",
    ...d.lines.map((l) => `• ${l.label}`), ...d.notes.map((n) => `Please check: ${n}`)].join("\n");

const HEADINGS: Record<Card["group"], string> = { match: "Matches", possible: "Not verified", alternative: "Nearby alternatives" };
/** The heading above a reply's cards. A reply never mixes groups. */
export const headingFor = (cards: Card[]): string | null => (cards.length ? HEADINGS[cards[0]!.group] : null);

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** One requirement as the customer sees it, with what removing it means. */
export interface Chip {
  label: string;
  /** Applied by the pipeline without a model when the customer removes the chip. */
  op: { unset?: Unsettable[]; remove?: string[] };
}

/** What is being searched for — shown back on every reply so a misreading is visible. */
export function filterChips(state: SearchState, today: string, placeName?: string): Chip[] {
  const chips: Chip[] = [];
  const unset = (label: string, ...fields: Unsettable[]) => chips.push({ label, op: { unset: fields } });
  const remove = (label: string, ...items: string[]) => chips.push({ label, op: { remove: items } });
  if (state.place) unset(placeName ?? state.place, "place");
  if (state.checkIn && state.checkOut) unset(formatDates(state.checkIn, state.checkOut, today), "dates");
  else if (state.nights) unset(plural(state.nights, "night", "nights"), "dates");
  const g = state.guests ? Math.max(state.guests.min ?? 0, state.guests.max ?? 0) : 0;
  if (g) unset(plural(g, "guest", "guests"), "guests");
  const p = state.price;
  if (p?.min !== undefined && p.max !== undefined) unset(`${inr(p.min)}–${inr(p.max)}/night`, "price");
  else if (p?.max !== undefined) unset(`up to ${inr(p.max)}/night`, "price");
  else if (p?.min !== undefined) unset(`from ${inr(p.min)}/night`, "price");
  for (const [key, one, many] of [["bedrooms", "bedroom", "bedrooms"], ["beds", "bed", "beds"], ["bathrooms", "bathroom", "bathrooms"]] as const) {
    const r = state[key];
    if (!r) continue;
    if (r.min !== undefined && r.min === r.max) unset(`exactly ${plural(r.min, one, many)}`, key);
    else if (r.min !== undefined && r.max !== undefined) unset(`${r.min}–${r.max} ${many}`, key);
    else if (r.min !== undefined) unset(`${r.min}+ ${many}`, key);
    else if (r.max !== undefined) unset(`up to ${plural(r.max, one, many)}`, key);
  }
  if (state.propertyType) unset(state.propertyType, "propertyType");
  if (state.placeType) unset(state.placeType === "entire" ? "entire place" : "room", "placeType");
  for (const x of state.amenitiesAll ?? []) remove(x, x);
  if (state.amenitiesAny?.length) remove(state.amenitiesAny.join(" or "), ...state.amenitiesAny);
  for (const x of state.amenitiesNone ?? []) remove(`no ${x}`, x);
  if (state.petsAllowed) unset("pets allowed", "petsAllowed");
  if (state.instantBook) unset("instant book", "instantBook");
  if (state.selfCheckIn) unset("self check-in", "selfCheckIn");
  if (state.cancellation) unset(`${state.cancellation} cancellation`, "cancellation");
  for (const u of state.unsupported ?? []) remove(u, u);
  return chips;
}

/** The same requirements as one line of text, for clients that do not draw chips. */
export const filtersLine = (state: SearchState, today: string, placeName?: string): string =>
  filterChips(state, today, placeName).map((c) => c.label).join(" · ");

const hasRequirements = (s: SearchState) => filtersLine(s, "2000-01-01") !== "";

/** A row can be a card only if it has what a card shows. */
const showable = (l: Listing) => typeof l.title === "string" && !!l.title.trim() && typeof l.basePrice === "number" && Number.isFinite(l.basePrice);

function card(e: Evaluated, group: Card["group"], dated: boolean, note?: string): Card {
  const l = e.listing;
  return {
    _id: l._id,
    title: l.title!,
    propertyType: l.propertyType ?? "",
    address: { city: l.address?.city ?? "", state: l.address?.state ?? "" },
    basePrice: l.basePrice!,
    averageRating: l.averageRating ?? 0,
    reviewCount: l.reviewCount ?? 0,
    photos: Array.isArray(l.photos) ? l.photos.slice(0, 1) : [],
    // a missing value is left out (the card then shows nothing), never drawn as 0
    ...(typeof l.guests === "number" ? { guests: l.guests } : {}),
    ...(typeof l.bedrooms === "number" ? { bedrooms: l.bedrooms } : {}),
    group,
    ...(note ? { note } : {}),
    ...(dated ? { availability: "available" as const } : {}),
  };
}

const PRICE_NOTE = "Prices are per night, before taxes and fees.";
export const AVAILABLE_NOTE = "Available for your dates when checked just now, confirmed at checkout.";
/** What a saved reply says instead, once "just now" is no longer true. */
export const RECHECK_NOTE = "Availability was checked when this was sent. Please recheck.";
const NO_DATES_NOTE = "Add your dates to check availability.";

export interface SearchContext {
  state: SearchState;
  catalog: CatalogResult;
  decision: Decision | null; // null when the catalogue call failed
  today: string;
  /** Filters mode: the guest edits filters with buttons (wording), dates are chosen on the stay page. */
  controls?: boolean;
  /** Lines that go before everything else: "Starting a fresh search." etc. */
  preface: string[];
}

export function searchReply(ctx: SearchContext): Reply {
  const { state, catalog, today } = ctx;
  const dated = !!(state.checkIn && state.checkOut);
  const head = (placeName?: string) => {
    const f = filtersLine(state, today, placeName);
    return [...ctx.preface, ...(f ? [f] : [])];
  };
  const place = catalog.kind === "ok" && catalog.scope === "place" ? catalog.placeName : undefined;
  const chips = filterChips(state, today, place);
  const chipsLine = chips.map((c) => c.label).join(" · ");
  const done = (outcome: Outcome, lines: string[], cards: Card[] = [], pending: Pending | null = null): Reply => ({
    text: lines.filter(Boolean).join("\n"),
    cards,
    outcome,
    pending,
    chips,
    chipsLine,
  });

  if (catalog.kind === "failed") {
    return done("unavailable", [...head(), "Search is temporarily unavailable. Please try again in a moment. You can also browse stays on the site or ask our team in the Support tab."]);
  }
  const d = ctx.decision!;
  const asked = state.place ?? "";
  const resolved = catalog.placeName;
  const lead = head(catalog.scope === "place" ? resolved : undefined);
  if (catalog.corrected && resolved) lead.push(`Showing results for ${resolved}.`);

  if (catalog.scope === "unrecognised") {
    return done("unrecognised_place", [...ctx.preface, `I couldn't recognise "${asked}" as a place we have stays in. Which city or area did you mean?`]);
  }
  if (catalog.scope === "name" && catalog.rows.length === 0) {
    // With dates, an empty result may just mean the stay is booked — do not say it does not exist.
    return done("name_not_found", [...ctx.preface, dated
      ? `I couldn't find "${asked}" free for those dates. It may be booked then, or the name may be different. Try other dates, or check the name.`
      : `I couldn't find a place or a stay called "${asked}". Could you check the name, or tell me the city or area?`]);
  }

  // Only rows that can be drawn as a card are counted or shown.
  const able = (rows: Evaluated[]) => rows.filter((r) => showable(r.listing));
  const cap = (rows: Evaluated[]) => able(rows).slice(0, MAX_CARDS);
  const confirmed = able(d.confirmed);
  const possible = able(d.possible);
  const tail = dated ? AVAILABLE_NOTE : NO_DATES_NOTE;
  // Filters mode keeps replies short: every card already says "/night · excl. taxes" and the first screen and the
  // editor say where dates, availability and the total are checked. Only an availability claim keeps its caveat.
  const notes = ctx.controls ? (dated ? [AVAILABLE_NOTE] : []) : [PRICE_NOTE, tail];
  const byDistance = (rows: Evaluated[]) => [...rows].sort((a, b) => (a.listing.distanceKm ?? Infinity) - (b.listing.distanceKm ?? Infinity));
  const sig = consentSignature(d);
  const what = list(d.unverified.map((u) => `"${u}"`));
  const unverifiedOf = (r: Evaluated) => r.results.filter((x) => x.status === "unknown" || x.status === "unsupported").map((x) => x.label).join(", ");

  // The API widened the place by itself: these stays are NOT where the customer asked.
  if (catalog.scope === "nearby") {
    const where = resolved ?? asked;
    const away = (r: Evaluated) => (typeof r.listing.distanceKm === "number" ? `${Math.round(r.listing.distanceKm)} km from ${where}` : `not in ${where}`);
    const near = byDistance(confirmed);
    const shown = cap(near);
    if (shown.length === 0 && possible.length > 0) {
      // Nothing nearby is a confirmed fit, but some stays only fail on what cannot be checked.
      const n = possible.length;
      if (state.consentFor !== sig) {
        return done(
          "possible_ask",
          [...lead, `No stays in ${where} itself${dated ? " for your dates" : ""}. Nearby, ${plural(n, "stay meets", "stays meet")} everything I can check, but I can't verify ${what}. Would you like to see ${n === 1 ? "it" : "them"}?`],
          [],
          { kind: "consent", signature: sig }
        );
      }
      const some = cap(byDistance(possible));
      return done(
        "nearby",
        [...lead, `No stays in ${where} itself${dated ? " for your dates" : ""}. Nearby, ${plural(n, "stay meets", "stays meet")} everything I can check${n > some.length ? ` (showing ${some.length})` : ""}. Not verified: ${what}. Please confirm on the listing before booking.`, ...notes],
        some.map((r) => card(r, "alternative", dated, `${away(r)} · not verified: ${unverifiedOf(r)}`))
      );
    }
    if (shown.length === 0) {
      return done("nearby_none", [...lead, `We don't have stays in ${where}${dated ? " that are free for your dates" : ""}, and nothing nearby meets your requirements.`]);
    }
    const km = shown.map((r) => r.listing.distanceKm).filter((x): x is number => typeof x === "number");
    const span = km.length ? `, ${Math.round(Math.min(...km))}${Math.round(Math.max(...km)) > Math.round(Math.min(...km)) ? `–${Math.round(Math.max(...km))}` : ""} km away` : "";
    return done(
      "nearby",
      [...lead, `No stays in ${where} itself${dated ? " for your dates" : ""}. Nearby alternatives${span}: ${plural(near.length, "stay", "stays")}${near.length > shown.length ? ` (showing ${shown.length})` : ""}.`, ...notes],
      shown.map((r) => card(r, "alternative", dated, away(r)))
    );
  }

  const incomplete = !catalog.complete;
  const checkedNote = incomplete ? `I could only check the first ${catalog.rows.length} of ${catalog.total} stays here. Add a detail (area, dates, budget) to narrow it down.` : "";

  if (confirmed.length > 0) {
    const shown = cap(confirmed);
    const n = confirmed.length;
    return done(
      incomplete ? "incomplete" : "matches",
      [...lead, `${plural(n, "stay matches", "stays match")}${hasRequirements(state) ? " everything you asked for" : ""}${n > shown.length ? ` (showing ${shown.length})` : ""}.`, checkedNote, ...notes],
      shown.map((r) => card(r, "match", dated))
    );
  }

  if (possible.length > 0) {
    const n = possible.length;
    if (state.consentFor === sig) {
      const shown = cap(possible);
      return done(
        "possible_shown",
        [...lead, `${plural(n, "stay meets", "stays meet")} everything I can check${n > shown.length ? ` (showing ${shown.length})` : ""}. Not verified: ${what}. Please confirm on the listing before booking.`, checkedNote, ...notes],
        shown.map((r) => card(r, "possible", dated, `not verified: ${unverifiedOf(r)}`))
      );
    }
    return done(
      "possible_ask",
      [...lead, `I found ${plural(n, "stay", "stays")} that ${n === 1 ? "meets" : "meet"} everything I can check, but I can't verify ${what}. Would you like to see ${n === 1 ? "it" : "them"}?`, checkedNote],
      [],
      { kind: "consent", signature: sig }
    );
  }

  if (incomplete) return done("incomplete", [...lead, `Nothing matched among the stays I could check. ${checkedNote}`]);

  // Nothing fits. Say exactly what stood in the way; never show a relaxed result unasked.
  const lines = [...lead, `Nothing matches all of that${dated ? " for your dates" : ""}.`];
  const before = lines.length;
  for (const m of d.nearMisses.slice(0, 3)) {
    // count only stays that could be shown if the customer relaxes this
    const rows = m.rows.filter((r) => showable(r.listing));
    const n = rows.length;
    if (!n) continue;
    if (m.key === "price") {
      const prices = rows.map((r) => r.listing.basePrice!).sort((a, b) => a - b);
      const over = state.price?.max !== undefined && prices[0]! > state.price.max;
      lines.push(`${plural(n, "stay meets", "stays meet")} everything except the budget, ${over ? `from ${inr(prices[0]!)}` : `up to ${inr(prices[prices.length - 1]!)}`} a night.`);
    } else if (m.key === "guests") {
      lines.push(`${plural(n, "stay meets", "stays meet")} everything except the group size. The largest sleeps ${Math.max(...rows.map((r) => r.listing.guests!))}.`);
    } else {
      lines.push(`${plural(n, "stay meets", "stays meet")} everything except "${m.label}".`);
    }
  }
  lines.push(ctx.controls
    ? (lines.length > before ? "Remove or change that filter to see them." : "Try a different area or budget.")
    : lines.length > before ? "Tell me which requirement to change and I'll show them." : "Try a different area, dates or budget.");
  return done("no_match", lines);
}

// ── fixed replies ───────────────────────────────────────────────────────────

const EXAMPLE = `"villa in North Goa for 6, under ₹15,000 a night, with a pool"`;

export const FIXED = {
  greeting: `Hi! Tell me where you'd like to stay, your dates, how many guests and your budget, and I'll find stays that fit, for example ${EXAMPLE}.`,
  thanks: "You're welcome! Tell me if you'd like to change anything or look somewhere else.",
  reset: "Starting a fresh search. Where would you like to stay?",
  declined: "No problem. Tell me which requirement you'd like to change, or start a new search.",
  kept: "Okay, I've kept your search as it was. Tell me what you'd like to change.",
  need_details: `Where would you like to stay? You can also give dates, guests and a budget, for example ${EXAMPLE}.`,
  support: "For help with an existing booking, please switch to the Support tab. Our team can look it up for you.",
  travel_off: `I can find stays for you. Give me a place, dates, guests and budget. I can't give general travel advice yet.`,
  other: `I'm not sure I understood. I can search stays by place, dates, guests, budget and amenities, for example ${EXAMPLE}.`,
  not_processed: "I couldn't process that just now. Please try again.",
  busy: "I'm getting a lot of questions right now. Please try again in a little while, or browse stays on the site.",
  retry: "I'm still working on your previous message. Please send that again in a moment.",
  which_stay: `Which stay do you mean? You can say "the first one", "the second one", or give its name.`,
  info_unavailable: "I couldn't look that up just now. Please try again in a moment, or open the stay's page for its details.",
  safe: "Stay search by chat is being upgraded. Please use the search on the site to find stays, or the Support tab to reach our team.",
  use_filters: "Use the filter buttons to set your search.",
  draft_busy: "I couldn't read that just now. Your filters are unchanged; use the filter buttons.",
  draft_other: "I couldn't turn that into filters. Your filters are unchanged; try saying it another way or use the filter buttons.",
} as const;

const POLICY_PAGES: Record<PolicyTopic, string> = {
  cancellation: "https://majesticescape.in/cancellation-policy",
  refund: "https://majesticescape.in/refund-policy",
  payment: "https://majesticescape.in/terms-of-service",
  privacy: "https://majesticescape.in/privacy-policy",
  terms: "https://majesticescape.in/terms-of-service",
  other: "https://majesticescape.in/faq",
};
/** No figures here on purpose: the policy pages are the authority. */
export function policyReply(topic: PolicyTopic | undefined): string {
  const t = topic ?? "other";
  const name = t === "other" ? "our policies" : `our ${t} policy`;
  return `You can read ${name} here: ${POLICY_PAGES[t]}. Each stay's own cancellation terms are on its page. For anything about your own booking, our team can help in the Support tab.`;
}

const CLARIFY: Record<ClarifyReason, string> = {
  numbers: `I want to be sure I have the numbers right. Could you say them again, for example "8 guests, up to ₹10,000 a night"?`,
  negation: `I wasn't sure what you'd like me to leave out. Could you rephrase, for example "no pool" or "any budget"?`,
  budget_basis: "I can only filter by price per night (before taxes and fees). What's your budget per night?",
  budget_direction: `Is that the most you want to pay per night, or the least? For example "up to ₹10,000" or "at least ₹10,000".`,
  place: "Which place did you mean? Please type the city, area or stay name.",
  contradiction: "Those requirements conflict with each other. Could you tell me again what you need?",
  dates_no_cue: `Which dates would you like? Please give check-in and check-out, for example "24 to 27 Dec".`,
  dates_half: `I need both check-in and check-out, for example "24 to 27 Dec".`,
  dates_length: `Should I keep your check-in day? Tell me the number of nights, for example "4 nights", or both dates, for example "24 to 27 Dec".`,
  dates_invalid: `I couldn't read those dates. Could you give them like "24 to 27 Dec"?`,
  dates_order: "Check-out needs to be after check-in. Which dates would you like?",
  dates_past: "Those dates are in the past. Which dates would you like?",
  dates_too_long: "I can search stays of up to 366 nights. Could you shorten the dates?",
};
export const clarifyReply = (why: ClarifyReason) => CLARIFY[why];

/** One focused question about a change we were not sure of, showing the search it would give. Nothing is
 *  applied until the customer says yes. null = the change would not alter the filters (ask nothing). */
export function confirmQuestion(prev: SearchState, next: SearchState, today: string): string | null {
  const before = filterChips(prev, today).map((c) => c.label);
  const after = filterChips(next, today).map((c) => c.label);
  const removed = before.filter((l) => !after.includes(l));
  const added = after.filter((l) => !before.includes(l));
  if (!added.length && !removed.length) return null;
  const what = !removed.length ? `add ${list(added)}` : !added.length ? `remove ${list(removed)}` : `change ${list(removed)} to ${list(added)}`;
  return `Just to check: should I ${what}? Your search would be: ${after.join(" · ") || "no filters"}. (yes / no)`;
}

// ── final validation ────────────────────────────────────────────────────────

/** Re-derives what a finished reply may contain from the evidence. Returns the
 *  defects found; any defect means the reply is not sent. */
export function validateReply(reply: Reply, ev: { state: SearchState; catalog: CatalogResult; decision: Decision | null }): string[] {
  const defects: string[] = [];
  const { cards } = reply;
  if (cards.length > MAX_CARDS) defects.push("too many cards");
  if (new Set(cards.map((c) => c._id)).size !== cards.length) defects.push("duplicate card");
  if (new Set(cards.map((c) => c.group)).size > 1) defects.push("mixed groups");
  if (cards.length && (ev.catalog.kind !== "ok" || !ev.decision)) return [...defects, "cards without evidence"];

  const allowedRupees = new Set<number>();
  for (const v of [ev.state.price?.min, ev.state.price?.max]) if (v !== undefined) allowedRupees.add(v);
  // A must-have is shown back in the customer's words, which may hold an amount
  // ("breakfast under ₹500"). That is their text, not a price we are quoting.
  for (const label of ev.state.unsupported ?? []) {
    for (const m of label.matchAll(/[\d,]+/g)) allowedRupees.add(Number(m[0].replace(/,/g, "")));
  }

  if (ev.catalog.kind === "ok" && ev.decision) {
    const d = ev.decision;
    const dated = !!(ev.state.checkIn && ev.state.checkOut);
    const byId = new Map([...d.confirmed, ...d.possible, ...d.excluded].map((e) => [e.listing._id, e]));
    for (const e of byId.values()) if (typeof e.listing.basePrice === "number") allowedRupees.add(e.listing.basePrice);
    const nearby = ev.catalog.scope === "nearby";
    for (const c of cards) {
      const e = byId.get(c._id);
      if (!e) { defects.push(`card ${c._id} is not in the evidence`); continue; }
      const l = e.listing;
      if (c.title !== l.title || c.basePrice !== l.basePrice || c.guests !== (typeof l.guests === "number" ? l.guests : undefined) || c.bedrooms !== (typeof l.bedrooms === "number" ? l.bedrooms : undefined)) defects.push(`card ${c._id} differs from its listing`);
      if (c.address.city !== (l.address?.city ?? "") || c.address.state !== (l.address?.state ?? "")) defects.push(`card ${c._id} place differs`);
      // match → confirmed only; possible → possible only; a nearby alternative may be either.
      const fits = c.group === "match" ? e.cls === "confirmed" : c.group === "possible" ? e.cls === "possible" : e.cls !== "excluded";
      if (!fits) defects.push(`card ${c._id} shown as ${c.group} but is ${e.cls}`);
      if ((c.group === "alternative") !== nearby) defects.push(`card ${c._id} group does not fit the search scope`);
      if (e.cls === "possible" && ev.state.consentFor !== consentSignature(d)) defects.push("unverified stays shown without consent");
      if ((c.availability === "available") !== dated) defects.push(`card ${c._id} availability without a dated search`);
    }
    if (reply.outcome === "matches" && (d.confirmed.length === 0 || !ev.catalog.complete || nearby)) defects.push("'matches' without confirmed, complete, in-place evidence");
  }
  for (const m of reply.text.matchAll(/₹\s?([\d,]+)/g)) {
    const n = Number(m[1]!.replace(/,/g, ""));
    if (!allowedRupees.has(n)) defects.push(`amount ₹${n} is not in the evidence`);
  }
  const claimsMatch = /\b(stay matches|stays match)\b/.test(reply.text);
  if (claimsMatch && reply.outcome !== "matches" && reply.outcome !== "incomplete") defects.push("match wording outside a confirmed result");
  if (/Available for your dates/.test(reply.text) && !(ev.state.checkIn && ev.state.checkOut)) defects.push("availability stated without dates");
  return defects;
}
