// The requirement validator: every listing × every mandatory requirement →
// satisfied | unsatisfied | unknown | unsupported. Pure — no I/O.
//
// The rule the whole pipeline rests on: a stay is a CONFIRMED match only when
// every mandatory requirement is `satisfied`. Missing data is `unknown`, a
// requirement no field can prove is `unsupported`; neither ever counts as met.

import type { Evaluated, Listing, MatchClass, Range, ReqResult, ReqStatus, SearchState } from "./types";

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function rangeLabel(r: Range, one: string, many: string): string {
  const unit = (n: number) => (n === 1 ? one : many);
  if (r.min !== undefined && r.max !== undefined) {
    return r.min === r.max ? `exactly ${r.min} ${unit(r.min)}` : `${r.min}–${r.max} ${many}`;
  }
  if (r.min !== undefined) return `${r.min}+ ${unit(r.min)}`;
  return `up to ${r.max} ${unit(r.max!)}`;
}

function priceLabel(r: Range): string {
  if (r.min !== undefined && r.max !== undefined) return `${inr(r.min)}–${inr(r.max)} a night`;
  if (r.max !== undefined) return `up to ${inr(r.max)} a night`;
  return `from ${inr(r.min!)} a night`;
}

// A number field: absent / non-finite → unknown, never a guess.
function inRange(value: unknown, r: Range): ReqStatus {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  if (r.min !== undefined && value < r.min) return "unsatisfied";
  if (r.max !== undefined && value > r.max) return "unsatisfied";
  return "satisfied";
}

function flag(value: unknown): ReqStatus {
  return value === true ? "satisfied" : value === false ? "unsatisfied" : "unknown";
}

function has(list: unknown, key: string): ReqStatus {
  if (!Array.isArray(list)) return "unknown";
  return list.includes(key) ? "satisfied" : "unsatisfied";
}

const emptyRange = (r?: Range) => !r || (r.min === undefined && r.max === undefined);

/** Every mandatory requirement in `state`, judged against one listing. */
export function evaluate(l: Listing, state: SearchState): ReqResult[] {
  const out: ReqResult[] = [];
  const add = (key: string, label: string, status: ReqStatus) => out.push({ key, label, status });

  // `guests` asks for capacity: "8 guests" is met by any stay that sleeps 8+.
  if (!emptyRange(state.guests)) {
    const g = state.guests!;
    const need = Math.max(g.min ?? 0, g.max ?? 0); // "4 to 6 people" needs room for 6
    const cap = l.guests;
    const status: ReqStatus =
      typeof cap !== "number" || !Number.isFinite(cap) ? "unknown" : cap >= need ? "satisfied" : "unsatisfied";
    add("guests", `${need} ${need === 1 ? "guest" : "guests"}`, status);
  }
  if (!emptyRange(state.bedrooms)) add("bedrooms", rangeLabel(state.bedrooms!, "bedroom", "bedrooms"), inRange(l.bedrooms, state.bedrooms!));
  if (!emptyRange(state.beds)) add("beds", rangeLabel(state.beds!, "bed", "beds"), inRange(l.beds, state.beds!));
  if (!emptyRange(state.bathrooms)) add("bathrooms", rangeLabel(state.bathrooms!, "bathroom", "bathrooms"), inRange(l.bathrooms, state.bathrooms!));
  if (!emptyRange(state.price)) add("price", priceLabel(state.price!), inRange(l.basePrice, state.price!));

  if (state.propertyType) {
    const want = norm(state.propertyType);
    const got = typeof l.propertyType === "string" && l.propertyType.trim() ? norm(l.propertyType) : null;
    // Equality, not substring: "house" must not match "guesthouse" or "farmhouse".
    add("propertyType", state.propertyType, got === null ? "unknown" : got === want ? "satisfied" : "unsatisfied");
  }
  if (state.placeType) {
    const got = l.placeType;
    const status: ReqStatus =
      typeof got !== "string" || !got
        ? "unknown"
        : state.placeType === "entire"
        ? got === "entire" ? "satisfied" : "unsatisfied"
        : got === "entire" ? "unsatisfied" : "satisfied"; // room | private | shared
    add("placeType", state.placeType === "entire" ? "entire place" : "a room", status);
  }

  for (const a of state.amenitiesAll ?? []) add(`amenity:${a}`, a, has(l.amenities, a));
  if (state.amenitiesAny?.length) {
    const any = state.amenitiesAny;
    const status: ReqStatus = !Array.isArray(l.amenities)
      ? "unknown"
      : any.some((a) => l.amenities!.includes(a)) ? "satisfied" : "unsatisfied";
    add(`amenityAny:${any.join("|")}`, any.join(" or "), status);
  }
  for (const a of state.amenitiesNone ?? []) {
    const s = has(l.amenities, a);
    add(`noAmenity:${a}`, `no ${a}`, s === "unknown" ? "unknown" : s === "satisfied" ? "unsatisfied" : "satisfied");
  }

  // "Pet-friendly" has no field. A "no pets" rule disproves it; its absence proves nothing.
  if (state.petsAllowed) {
    const rules = l.selectedRules;
    add("petsAllowed", "pets allowed", Array.isArray(rules) && rules.includes("no_pets") ? "unsatisfied" : "unsupported");
  }
  if (state.instantBook) add("instantBook", "instant book", flag(l.bookingType?.instantBook));
  if (state.selfCheckIn) add("selfCheckIn", "self check-in", has(l.occupancy, "self-check-in"));
  if (state.cancellation) add("cancellation", `${state.cancellation} cancellation`, flag(l.cancellationType?.[state.cancellation]));

  for (const u of state.unsupported ?? []) add(`unsupported:${u}`, u, "unsupported");

  // Defence in depth: the API already filters to public listings.
  if (l.status !== undefined && l.status !== "active") add("status", "listed", "unsatisfied");
  return out;
}

export function classify(results: ReqResult[]): MatchClass {
  if (results.some((r) => r.status === "unsatisfied")) return "excluded";
  if (results.some((r) => r.status === "unknown" || r.status === "unsupported")) return "possible";
  return "confirmed";
}

export interface Decision {
  confirmed: Evaluated[];
  /** Nothing disproved, something unverifiable. Never shown as matches. */
  possible: Evaluated[];
  excluded: Evaluated[];
  /** Excluded by exactly one requirement, everything else satisfied — the honest "closest" set. */
  nearMisses: { key: string; label: string; rows: Evaluated[] }[];
  /** Labels of the requirements that keep `possible` rows from being confirmed. */
  unverified: string[];
}

export function decide(listings: Listing[], state: SearchState): Decision {
  const rows: Evaluated[] = listings.map((listing) => {
    const results = evaluate(listing, state);
    return { listing, results, cls: classify(results) };
  });
  const confirmed = rows.filter((r) => r.cls === "confirmed");
  const possible = rows.filter((r) => r.cls === "possible");
  const excluded = rows.filter((r) => r.cls === "excluded");

  const byKey = new Map<string, { key: string; label: string; rows: Evaluated[] }>();
  for (const r of excluded) {
    const failed = r.results.filter((x) => x.status === "unsatisfied");
    const rest = r.results.filter((x) => x.status !== "unsatisfied");
    if (failed.length !== 1 || rest.some((x) => x.status !== "satisfied")) continue;
    const f = failed[0]!;
    if (f.key === "status") continue;
    const g = byKey.get(f.key) ?? { key: f.key, label: f.label, rows: [] };
    g.rows.push(r);
    byKey.set(f.key, g);
  }

  const unverified = [
    ...new Set(
      possible.flatMap((r) =>
        r.results.filter((x) => x.status === "unknown" || x.status === "unsupported").map((x) => x.label)
      )
    ),
  ];
  return { confirmed, possible, excluded, nearMisses: [...byKey.values()], unverified };
}

/** Changes whenever the set of unverifiable requirements changes, so an earlier "yes, show them" cannot cover a new one. */
export function consentSignature(d: Decision): string {
  return [...d.unverified].sort().join("|");
}
