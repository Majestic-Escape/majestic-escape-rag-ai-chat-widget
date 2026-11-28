// Pure checks for the search pipeline (src/lib/rag). No network, no database,
// no model: everything here is deterministic and runs in a second.
//
// Run:  npm run verify:rag            (optionally: -- <group> to run one group)

import { AMENITY_KEYS, type Listing, type SearchState } from "../src/lib/rag/types";
import { classify, consentSignature, decide, evaluate } from "../src/lib/rag/requirements";
import { dateProblem, formatDates, isRealDate, istToday, nightsBetween, weekdayOf } from "../src/lib/rag/dates";
import { fetchCandidates, parsePage, scopeOf, searchUrl } from "../src/lib/rag/catalog";
import { readFileSync } from "node:fs";
import { hasDateCue, hasNegation, hasNonNightlyBudgetCue, headcount, numbersIn, redactForModel } from "../src/lib/rag/numbers";
import { applyDelta, crossCheck, fastPath, judgeRemovals, normaliseExact, ownWords, revalidate, saidIn, stripRestated, understandInput, validateProposal, type Proposal } from "../src/lib/rag/understand";
import { handleTurn, type PipelineDeps, type TurnResult } from "../src/lib/rag/pipeline";
import { guestIdForUnverifiedToken, memoryStore, stateKey, IDLE_MS, type StateStore } from "../src/lib/rag/state";
import { failureKind, isHindiOrHinglish, newHealth, parseChain, parseJson, proposeJson, providerId, routeChain, type LlmConfig, type LlmResult, type Provider } from "../src/lib/rag/llm";
import { diffOp, draftEditPlan, formOf, mergeOps } from "../src/embed/FilterEditor";
import { FIXED, draftOf, searchReply, validateReply, type Reply } from "../src/lib/rag/reply";
import { inquire } from "../src/lib/rag/inquire";
import { applyGuards, negatedAmenities, writtenDates } from "../src/lib/rag/guards";
import { quickRead } from "../src/lib/rag/quick";
import { canaryPercent, chatIdentity, inCanary, pilotLive, pipelineMode } from "../src/lib/rag/runtime";

let failures = 0;
let passes = 0;
const only = process.argv[2];

// Key order carries no meaning (two readers build the same state in different orders).
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, canon(x)]))
  : v;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(canon(actual));
  const e = JSON.stringify(canon(expected));
  if (a === e) passes++;
  else {
    console.error(`  FAIL  ${label}\n        expected ${e}\n        got      ${a}`);
    failures++;
  }
}
function group(name: string, fn: () => void | Promise<void>): Promise<void> {
  if (only && only !== name) return Promise.resolve();
  const before = failures;
  const start = passes;
  return Promise.resolve(fn()).then(() => {
    console.log(`${failures === before ? "PASS" : "FAIL"}  ${name}  (${passes - start} checks)`);
  });
}

// Seeded generator — the invariant tests must be reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const villa: Listing = {
  _id: "L1", title: "Casa Test", propertyType: "villa", placeType: "entire",
  guests: 8, bedrooms: 4, beds: 5, bathrooms: 4, basePrice: 35000,
  amenities: ["wifi", "pool", "kitchen"], selectedRules: ["no_smoking"],
  bookingType: { instantBook: false, manual: true }, cancellationType: { moderate: true, flexible: false, strict: false },
  occupancy: ["self-check-in"], address: { city: "Anjuna", state: "Goa" }, status: "active",
};
const statusOf = (l: Listing, s: SearchState, key: string) => evaluate(l, s).find((r) => r.key === key)?.status;
const cls = (l: Listing, s: SearchState) => classify(evaluate(l, s));
const SEARCH = new Set(["matches", "possible_ask", "possible_shown", "no_match", "nearby", "nearby_none", "unrecognised_place", "name_not_found", "incomplete", "need_details", "unavailable"]);

async function main(): Promise<void> {
  await group("requirements", () => {
    // Boundaries: a budget is inclusive, capacity is "sleeps at least".
    check("price at the limit is satisfied", statusOf(villa, { price: { max: 35000 } }, "price"), "satisfied");
    check("price one rupee over is unsatisfied", statusOf(villa, { price: { max: 34999 } }, "price"), "unsatisfied");
    check("price below a minimum is unsatisfied", statusOf(villa, { price: { min: 35001 } }, "price"), "unsatisfied");
    check("guests equal to capacity", statusOf(villa, { guests: { min: 8 } }, "guests"), "satisfied");
    check("guests one over capacity", statusOf(villa, { guests: { min: 9 } }, "guests"), "unsatisfied");
    check("smaller group fits a bigger stay", statusOf(villa, { guests: { min: 2 } }, "guests"), "satisfied");
    check("exactly 4 bedrooms", statusOf(villa, { bedrooms: { min: 4, max: 4 } }, "bedrooms"), "satisfied");
    check("exactly 3 bedrooms fails on a 4-bedroom", statusOf(villa, { bedrooms: { min: 3, max: 3 } }, "bedrooms"), "unsatisfied");

    // Missing data is unknown — never satisfied, never a silent pass.
    check("missing price → unknown", statusOf({ ...villa, basePrice: undefined }, { price: { max: 1 } }, "price"), "unknown");
    check("null bedrooms → unknown", statusOf({ ...villa, bedrooms: null as unknown as number }, { bedrooms: { min: 1 } }, "bedrooms"), "unknown");
    check("NaN guests → unknown", statusOf({ ...villa, guests: NaN }, { guests: { min: 1 } }, "guests"), "unknown");
    check("missing amenities → unknown", statusOf({ ...villa, amenities: undefined }, { amenitiesAll: ["pool"] }, "amenity:pool"), "unknown");
    check("a row with an unknown is not a confirmed match", cls({ ...villa, basePrice: undefined }, { price: { max: 99999 } }), "possible");

    // Type: equality, so "house" is not "guesthouse".
    check("villa = Villa", statusOf({ ...villa, propertyType: "Villa" }, { propertyType: "villa" }, "propertyType"), "satisfied");
    check("house ≠ guesthouse", statusOf({ ...villa, propertyType: "guesthouse" }, { propertyType: "house" }, "propertyType"), "unsatisfied");
    check("guest house = guesthouse", statusOf({ ...villa, propertyType: "guesthouse" }, { propertyType: "Guest house" }, "propertyType"), "satisfied");
    check("entire place", statusOf(villa, { placeType: "entire" }, "placeType"), "satisfied");
    check("a room is not an entire place", statusOf({ ...villa, placeType: "room" }, { placeType: "entire" }, "placeType"), "unsatisfied");
    check("private room counts as a room", statusOf({ ...villa, placeType: "private" }, { placeType: "room" }, "placeType"), "satisfied");

    // Amenities: AND, one OR group, exclusions.
    check("has pool", statusOf(villa, { amenitiesAll: ["pool"] }, "amenity:pool"), "satisfied");
    check("no bbq", statusOf(villa, { amenitiesAll: ["bbq"] }, "amenity:bbq"), "unsatisfied");
    check("pool or beach", statusOf(villa, { amenitiesAny: ["beach", "pool"] }, "amenityAny:beach|pool"), "satisfied");
    check("lake or beach", statusOf(villa, { amenitiesAny: ["lake", "beach"] }, "amenityAny:lake|beach"), "unsatisfied");
    check("excluded amenity present", statusOf(villa, { amenitiesNone: ["pool"] }, "noAmenity:pool"), "unsatisfied");
    check("excluded amenity absent", statusOf(villa, { amenitiesNone: ["tv"] }, "noAmenity:tv"), "satisfied");

    // Unsupported requirements are never met — the "private pool" rule.
    const privatePool: SearchState = { amenitiesAll: ["pool"], unsupported: ["private pool"] };
    check("private pool is unsupported", statusOf(villa, privatePool, "unsupported:private pool"), "unsupported");
    check("a pool villa is only a POSSIBLE match for private pool", cls(villa, privatePool), "possible");
    check("pets: no rule proves nothing", statusOf(villa, { petsAllowed: true }, "petsAllowed"), "unsupported");
    check("pets: a no-pets rule disproves it", statusOf({ ...villa, selectedRules: ["no_pets"] }, { petsAllowed: true }, "petsAllowed"), "unsatisfied");

    check("instant book false", statusOf(villa, { instantBook: true }, "instantBook"), "unsatisfied");
    check("instant book missing → unknown", statusOf({ ...villa, bookingType: undefined }, { instantBook: true }, "instantBook"), "unknown");
    check("moderate cancellation", statusOf(villa, { cancellation: "moderate" }, "cancellation"), "satisfied");
    check("flexible cancellation", statusOf(villa, { cancellation: "flexible" }, "cancellation"), "unsatisfied");
    check("self check-in", statusOf(villa, { selfCheckIn: true }, "selfCheckIn"), "satisfied");
    check("inactive listing is excluded", cls({ ...villa, status: "inactive" }, {}), "excluded");
    check("soft wishes never filter", cls(villa, { soft: ["quiet", "romantic"] }), "confirmed");
    check("no requirements → confirmed", cls(villa, {}), "confirmed");

    // decide(): groups, near-misses, consent signature.
    const cheap: Listing = { ...villa, _id: "L2", basePrice: 9000, guests: 4 };
    const d = decide([villa, cheap], { guests: { min: 8 }, price: { max: 10000 } });
    check("nothing confirmed", d.confirmed.length, 0);
    check("near-miss groups name the single blocker", d.nearMisses.map((n) => [n.key, n.rows.map((r) => r.listing._id)]), [["price", ["L1"]], ["guests", ["L2"]]]);
    const d2 = decide([villa], privatePool);
    check("possible, with the unverified label", [d2.possible.length, d2.unverified], [1, ["private pool"]]);
    check("consent signature follows the unverified set", consentSignature(d2), "private pool");
    check("a new unverifiable requirement changes the signature", consentSignature(decide([villa], { ...privatePool, unsupported: ["private pool", "wheelchair access"] })), "private pool|wheelchair access");
  });

  await group("requirements-invariants", () => {
    // An independent oracle: written without the validator's helpers on purpose.
    const oracleConfirmed = (l: Listing, s: SearchState): boolean => {
      const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
      if (l.status !== undefined && l.status !== "active") return false;
      if (s.unsupported?.length || s.petsAllowed) return false;
      if (s.guests && !(num(l.guests) && l.guests! >= (s.guests.min ?? s.guests.max!))) return false;
      for (const [f, r] of [["bedrooms", s.bedrooms], ["beds", s.beds], ["bathrooms", s.bathrooms], ["basePrice", s.price]] as const) {
        if (!r) continue;
        const v = (l as unknown as Record<string, unknown>)[f];
        if (!num(v)) return false;
        if (r.min !== undefined && (v as number) < r.min) return false;
        if (r.max !== undefined && (v as number) > r.max) return false;
      }
      if (s.placeType && !(typeof l.placeType === "string" && (s.placeType === "entire") === (l.placeType === "entire"))) return false;
      if (s.amenitiesAll?.some((a) => !l.amenities?.includes(a))) return false;
      if (s.amenitiesAll?.length && !Array.isArray(l.amenities)) return false;
      if (s.amenitiesAny?.length && !s.amenitiesAny.some((a) => l.amenities?.includes(a))) return false;
      if (s.amenitiesNone?.length && (!Array.isArray(l.amenities) || s.amenitiesNone.some((a) => l.amenities!.includes(a)))) return false;
      if (s.instantBook && l.bookingType?.instantBook !== true) return false;
      return true;
    };

    const r = rng(20261125);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const maybe = <T,>(v: T, p = 0.12): T | undefined => (r() < p ? undefined : v);
    const some = () => AMENITY_KEYS.filter(() => r() < 0.35);
    let confirmedSeen = 0, possibleSeen = 0, excludedSeen = 0;
    let disagreements = 0, unknownConfirmed = 0, partition = 0;

    for (let i = 0; i < 4000; i++) {
      const l: Listing = {
        _id: `G${i}`,
        placeType: maybe(pick(["entire", "room", "private", "shared"])),
        guests: maybe(1 + Math.floor(r() * 16)),
        bedrooms: maybe(1 + Math.floor(r() * 7)),
        beds: maybe(1 + Math.floor(r() * 9)),
        bathrooms: maybe(1 + Math.floor(r() * 7)),
        basePrice: maybe(pick([2000, 3000, 7500, 10000, 10001, 35000, 75000])),
        amenities: maybe(some()),
        bookingType: maybe({ instantBook: r() < 0.3 }),
        selectedRules: r() < 0.4 ? ["no_pets"] : [],
        status: r() < 0.9 ? "active" : "inactive",
      };
      const s: SearchState = {};
      if (r() < 0.5) s.guests = { min: 1 + Math.floor(r() * 12) };
      if (r() < 0.4) s.price = r() < 0.7 ? { max: pick([3000, 10000, 40000]) } : { min: 3000, max: 40000 };
      if (r() < 0.3) s.bedrooms = r() < 0.5 ? { min: 1 + Math.floor(r() * 4) } : { min: 3, max: 3 };
      if (r() < 0.15) s.beds = { min: 2 };
      if (r() < 0.15) s.bathrooms = { min: 2 };
      if (r() < 0.25) s.placeType = pick(["entire", "room"] as const);
      if (r() < 0.35) s.amenitiesAll = [pick(AMENITY_KEYS)];
      if (r() < 0.15) s.amenitiesAny = [pick(AMENITY_KEYS), pick(AMENITY_KEYS)];
      if (r() < 0.1) s.amenitiesNone = [pick(AMENITY_KEYS)];
      if (r() < 0.1) s.instantBook = true;
      if (r() < 0.08) s.petsAllowed = true;
      if (r() < 0.08) s.unsupported = ["private pool"];

      const results = evaluate(l, s);
      const c = classify(results);
      if (c === "confirmed") confirmedSeen++; else if (c === "possible") possibleSeen++; else excludedSeen++;
      if ((c === "confirmed") !== oracleConfirmed(l, s)) disagreements++;
      if (c === "confirmed" && results.some((x) => x.status !== "satisfied")) unknownConfirmed++;
      const hasUnsat = results.some((x) => x.status === "unsatisfied");
      if ((c === "excluded") !== hasUnsat) partition++;
    }
    check("validator and independent oracle agree on every confirmed match (4000 cases)", disagreements, 0);
    check("no confirmed match carries an unknown or unsupported requirement", unknownConfirmed, 0);
    check("excluded ⇔ at least one requirement disproved", partition, 0);
    check("the generator exercised all three classes", [confirmedSeen > 100, possibleSeen > 100, excludedSeen > 100], [true, true, true]);
  });

  await group("dates", () => {
    // India's date, not the server's: 19:00 UTC is already tomorrow in India.
    check("00:30 IST is the new day", istToday(new Date("2026-11-24T19:00:00Z")), "2026-11-25");
    check("23:59 IST is still today", istToday(new Date("2026-11-25T18:29:00Z")), "2026-11-25");
    check("year end in IST", istToday(new Date("2026-12-31T18:30:00Z")), "2027-01-01");

    check("real date", isRealDate("2026-12-24"), true);
    check("30 Feb is not a date", isRealDate("2026-02-30"), false);
    check("29 Feb 2027 is not a date", isRealDate("2027-02-29"), false);
    check("29 Feb 2028 is a date", isRealDate("2028-02-29"), true);
    check("month 13", isRealDate("2026-13-01"), false);
    check("words are not dates", isRealDate("tomorrow"), false);
    check("a timestamp is not a calendar date", isRealDate("2026-12-24T00:00:00Z"), false);

    const today = "2026-11-25";
    check("no dates is fine", dateProblem(undefined, undefined, today), null);
    check("one date alone", dateProblem("2026-12-24", undefined, today), "half");
    check("same-day checkout", dateProblem("2026-12-24", "2026-12-24", today), "order");
    check("checkout before check-in", dateProblem("2026-12-27", "2026-12-24", today), "order");
    check("check-in yesterday", dateProblem("2026-11-24", "2026-11-26", today), "past");
    check("check-in today is allowed", dateProblem("2026-11-25", "2026-11-26", today), null);
    check("366 nights allowed", dateProblem("2026-12-01", "2027-12-02", today), null);
    check("367 nights refused", dateProblem("2026-12-01", "2027-12-03", today), "too_long");
    check("invalid calendar date", dateProblem("2026-02-30", "2026-03-02", today), "invalid");

    check("nights across a month end", nightsBetween("2026-12-30", "2027-01-02"), 3);
    check("nights across 29 Feb", nightsBetween("2028-02-28", "2028-03-01"), 2);
    check("weekday", weekdayOf("2026-11-25"), "Wednesday");
    check("same month", formatDates("2026-12-24", "2026-12-27", today), "24–27 Dec");
    check("across a year end", formatDates("2026-12-30", "2027-01-02", today), "30 Dec – 2 Jan 2027");
  });

  await group("catalog", async () => {
    const saved = (name: string) => JSON.parse(readFileSync(`eval/contract/${name}.json`, "utf8")) as { status: number; body: unknown };
    const never = new AbortController().signal;
    const base = "https://api.example/api/v1";

    // The URL: place + dates only, always an explicit page size.
    const u = new URL(searchUrl(base, { place: "South Goa", checkIn: "2026-12-24", checkOut: "2026-12-27" }, 2));
    check("path", u.pathname, "/api/v1/properties/search-properties");
    check("only place, dates, limit, page are sent", [...u.searchParams.keys()].sort(), ["from", "limit", "location", "page", "to"]);
    check("values", [u.searchParams.get("location"), u.searchParams.get("from"), u.searchParams.get("to"), u.searchParams.get("limit"), u.searchParams.get("page")], ["South Goa", "2026-12-24", "2026-12-27", "50", "2"]);
    check("a lone date is never sent", [...new URL(searchUrl(base, { checkIn: "2026-12-24" }, 1)).searchParams.keys()].sort(), ["limit", "page"]);

    // Real responses.
    const p = (n: string) => parsePage(saved(n).status, saved(n).body);
    const mode = (n: string) => { const x = p(n); return typeof x === "string" ? x : x.mode; };
    check("contract: no place → all", mode("all-limit50"), "all");
    check("contract: Goa → place", mode("place-goa"), "place");
    check("contract: Panaji → nearby (the API widened it)", mode("nearby-panaji"), "nearby");
    check("contract: 'hills' → all", mode("vague-hills"), "all");
    check("contract: a stay name → text", mode("name-casa-feliz"), "text");
    check("contract: HTTP 400 is a failure, not an empty result", p("bad-number"), "http 400");
    const mumbay = p("corrected-mumbay");
    check("contract: typo corrected to Mumbai", typeof mumbay === "string" ? mumbay : [mumbay.corrected, mumbay.placeName, mumbay.rows.length], [true, "Mumbai", 0]);
    const all = p("all-limit50");
    const needed = ["_id", "title", "propertyType", "placeType", "guests", "bedrooms", "beds", "bathrooms", "amenities", "basePrice", "bookingType", "cancellationType", "selectedRules", "occupancy", "status", "address"];
    check("contract: every row carries every field the validator reads",
      typeof all === "string" ? all : all.rows.filter((r) => needed.some((k) => !(k in r))).length, 0);
    check("contract: default page is NOT the whole catalogue", (() => { const x = p("all-default-limit"); return typeof x === "string" ? x : x.rows.length < x.total; })(), true);

    check("scope: place", scopeOf("place", true), "place");
    check("scope: nearby is not the place", scopeOf("nearby", true), "nearby");
    check("scope: 'all' after a place was asked = not understood", scopeOf("all", true), "unrecognised");
    check("scope: 'all' with no place = everywhere", scopeOf("all", false), "everywhere");
    check("scope: an unknown mode is a contract change", scopeOf("fuzzy", true), null);

    check("malformed: not an object", parsePage(200, "<html>"), "body is not an object");
    check("malformed: no search.mode", parsePage(200, { data: [], pagination: { totalCount: 0 } }), "search.mode missing");
    check("malformed: no total", parsePage(200, { data: [], search: { mode: "all" } }), "pagination.totalCount missing");
    check("malformed: row without id", parsePage(200, { data: [{ title: "x" }], pagination: { totalCount: 1 }, search: { mode: "all" } }), "row without _id");

    // Paging against a fake backend of N stays.
    const backend = (n: number, opts: { failPage?: number; status?: number; shortPage?: number; growAfter?: number; dupes?: boolean } = {}) => {
      const calls: number[] = [];
      let served = 0;
      const f = (async (url: string | URL) => {
        const page = Number(new URL(String(url)).searchParams.get("page"));
        calls.push(page);
        served++;
        if (opts.failPage === page) return new Response("{}", { status: opts.status ?? 500 });
        const total = opts.growAfter && served > opts.growAfter ? n + 1 : n;
        let ids = Array.from({ length: n }, (_, i) => `S${i}`).slice((page - 1) * 50, page * 50);
        if (opts.shortPage === page) ids = [];
        if (opts.dupes && page > 1) ids = ["S0", ...ids];
        return Response.json({ data: ids.map((_id) => ({ _id })), pagination: { totalCount: total }, search: { mode: "all" } });
      }) as typeof fetch;
      return { f, calls };
    };
    const run = async (b: ReturnType<typeof backend>) => fetchCandidates({}, { baseUrl: base, fetch: b.f }, never);
    const brief = (r: Awaited<ReturnType<typeof run>>) => r.kind === "ok" ? [r.kind, r.complete, r.rows.length, r.total] : [r.kind, r.why];

    let b = backend(19);
    check("19 stays: one page, complete", brief(await run(b)), ["ok", true, 19, 19]);
    check("19 stays: one call", b.calls, [1]);
    b = backend(120);
    check("120 stays: all pages, complete", brief(await run(b)), ["ok", true, 120, 120]);
    check("120 stays: three calls", b.calls, [1, 2, 3]);
    b = backend(120, { dupes: true });
    check("duplicates across pages are removed", brief(await run(b)), ["ok", true, 120, 120]);
    b = backend(260);
    check("260 stays: page cap → INCOMPLETE, never 'no matches'", brief(await run(b)), ["ok", false, 200, 260]);
    b = backend(120, { shortPage: 2 });
    check("an empty page before the total → incomplete", brief(await run(b)), ["ok", false, 50, 120]);
    b = backend(120, { failPage: 2, status: 400 });
    check("a 4xx on any page fails the whole search", brief(await run(b)), ["failed", "http 400"]);
    check("a 4xx is not retried", b.calls, [1, 2]);
    b = backend(120, { failPage: 2, status: 503 });
    check("a 5xx is retried once, then fails", [brief(await run(b)), b.calls], [["failed", "http 503"], [1, 2, 2]]);
    b = backend(120, { growAfter: 1 });
    check("total changed between pages → start over once; a row the backend counts but never serves = incomplete", brief(await run(b)), ["ok", false, 120, 121]);
    const net = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    check("network error → failed", brief(await fetchCandidates({}, { baseUrl: base, fetch: net }, never)), ["failed", "network: TypeError"]);
    const gone = new AbortController();
    gone.abort();
    check("client gone → aborted, no retry", brief(await fetchCandidates({}, { baseUrl: base, fetch: net }, gone.signal)), ["failed", "aborted"]);

    // End to end over a saved response: Panaji rows are alternatives, not matches.
    const one = (name: string) => (async () => Response.json(saved(name).body, { status: saved(name).status })) as typeof fetch;
    const panaji = await fetchCandidates({ place: "panaji" }, { baseUrl: base, fetch: one("nearby-panaji") }, never);
    check("Panaji: scope nearby, rows carry distance", panaji.kind === "ok" ? [panaji.scope, panaji.rows.length, typeof panaji.rows[0]?.distanceKm] : panaji.why, ["nearby", 13, "number"]);
    const hills = await fetchCandidates({ place: "hills" }, { baseUrl: base, fetch: one("vague-hills") }, never);
    check("'hills': unrecognised place", hills.kind === "ok" ? hills.scope : hills.why, "unrecognised");
    const bad = await fetchCandidates({ place: "goa" }, { baseUrl: base, fetch: one("bad-number") }, never);
    check("HTTP 400 → failed", bad.kind, "failed");
  });

  await group("numbers", () => {
    const req = (t: string) => numbersIn(t).required;
    check("plain digits", req("villa for 8 under 10000"), [8, 10000]);
    check("Indian commas", req("budget ₹10,000 or 1,00,000"), [10000, 100000]);
    check("k suffix", req("under 10k"), [10000]);
    check("k is not eaten from 'kids'", req("4 kids"), [4]);
    check("hazaar", req("10 hazaar ke andar"), [10000]);
    check("decimal lakh", req("1.5 lakh total"), [150000]);
    check("word + multiplier", req("das hazaar tak"), [10000]);
    check("English word + multiplier", req("around ten thousand"), [10000]);
    check("range shares the multiplier", req("budget 8-10k"), [8000, 10000]);
    check("Devanagari digits", req("८ लोग"), [8]);
    check("Devanagari word + multiplier", req("दस हज़ार तक"), [10000]);
    check("4BHK", req("4bhk villa"), [4]);
    check("a phone number is ignored", req("call 9876543210"), []);
    check("bare words are optional, not required", numbersIn("do you have two villas for aath log"), { required: [], optional: [2, 2, 8] });
    check("couple → 2 (optional)", numbersIn("for a couple").optional, [2]);

    check("date cue: weekend", hasDateCue("this weekend"), true);
    check("contact details never reach a model", redactForModel("call me on 9876543210 or +91 98765 43210, mail a.b@example.com"), "call me on <phone> or <phone>, mail <email>");
    check("amounts and dates are left alone", redactForModel("villa for 8 under ₹1,00,000 from 24-12-2026, budget 1500000"), "villa for 8 under ₹1,00,000 from 24-12-2026, budget 1500000");
    check("date cue: kal", hasDateCue("kal se"), true);
    check("no date cue", hasDateCue("villa in goa with pool"), false);
    check("negation: without", hasNegation("villa without a pool"), true);
    check("negation: nahi chahiye", hasNegation("pool nahi chahiye"), true);
    check("negation noise ignored", hasNegation("no problem, show me villas"), false);
    check("not a negation", hasNegation("villa in north goa"), false);
    check("per person budget", hasNonNightlyBudgetCue("5000 per person"), true);
    check("total budget", hasNonNightlyBudgetCue("50k in total for 3 nights"), true);
    check("nightly budget", hasNonNightlyBudgetCue("under 10k a night"), false);
  });

  await group("understand", () => {
    const today = "2026-11-25";
    const P = (o: Record<string, unknown>) => validateProposal({ intent: "search", ...o });
    const ok = (o: Record<string, unknown>): Proposal => {
      const p = P(o);
      if (!p || typeof p === "string") throw new Error(`expected a proposal, got ${JSON.stringify(p)}`);
      return p;
    };

    // validation
    check("not an object", validateProposal("search"), null);
    check("unknown intent", validateProposal({ intent: "book_it" }), null);
    check("a bare number becomes a minimum", ok({ set: { guests: 8 } }).set.guests, { min: 8 });
    check("min above max is a contradiction", P({ set: { price: { min: 9000, max: 5000 } } }), "contradiction");
    check("require and exclude the same amenity", P({ set: { amenitiesAll: ["pool"], amenitiesNone: ["pool"] } }), "contradiction");
    check("zero, negative and fractional values are dropped", ok({ set: { guests: { min: 0 }, bedrooms: { min: -2 }, beds: { min: 2.5 } } }).set, {});
    check("an amenity outside the vocabulary is kept as unsupported, never dropped",
      [ok({ set: { amenitiesAll: ["pool", "jacuzzi"] } }).set.amenitiesAll, ok({ set: { amenitiesAll: ["pool", "jacuzzi"] } }).unsupported], [["pool"], ["jacuzzi"]]);
    check("a one-item OR group is just a requirement", ok({ set: { amenitiesAny: ["pool"] } }).set, { amenitiesAll: ["pool"] });
    check("unknown enum values are ignored", ok({ set: { placeType: "castle", cancellation: "free" } }).set, {});
    check("only `true` switches a flag on", ok({ set: { petsAllowed: "yes", instantBook: 1 } }).set, {});
    check("unset keeps known fields only", ok({ unset: ["price", "everything", "dates"] }).unset, ["price", "dates"]);
    check("priceBasis defaults to night", ok({}).priceBasis, "night");

    // an "unsupported" label that a real field already covers is an echo
    const un = (o: Record<string, unknown>) => ok(o).unsupported;
    check("echo: pool", un({ set: { amenitiesAll: ["pool"] }, unsupported: ["pool"] }), []);
    check("echo: pet friendly", un({ set: { petsAllowed: true }, unsupported: ["pet friendly"] }), []);
    check("echo: private room", un({ set: { placeType: "room" }, unsupported: ["private room"] }), []);
    check("echo: without a pool", un({ set: { amenitiesNone: ["pool"] }, unsupported: ["without a pool"] }), []);
    check("NOT an echo: private pool stays", un({ set: { amenitiesAll: ["pool"] }, unsupported: ["private pool"] }), ["private pool"]);
    check("NOT an echo: private pool stays even when a room is asked", un({ set: { amenitiesAll: ["pool"], placeType: "room" }, unsupported: ["private pool"] }), ["private pool"]);
    check("NOT an echo: sea view", un({ set: { amenitiesAll: ["beach"] }, unsupported: ["sea view"] }), ["sea view"]);
    check("NOT an echo: nothing covers it", un({ unsupported: ["wheelchair access"] }), ["wheelchair access"]);
    // "exactly" only when the customer said so
    const exact = (msg: string) => normaliseExact(msg, ok({ set: { bedrooms: { min: 3, max: 3 } } })).set.bedrooms;
    check("'3 bedroom villa' → at least 3", exact("3 bedroom villa in morjim"), { min: 3 });
    check("'exactly 3 bedrooms' stays exact", exact("exactly 3 bedrooms"), { min: 3, max: 3 });
    check("'sirf 3 bedroom' stays exact", exact("sirf 3 bedroom chahiye"), { min: 3, max: 3 });
    check("a real range is untouched", normaliseExact("2 to 4 bedrooms", ok({ set: { bedrooms: { min: 2, max: 4 } } })).set.bedrooms, { min: 2, max: 4 });
    check("guests min = max is the same as min (found on the live site: '…we are 6 people' asked for the numbers again)", normaliseExact("5 to 8 december, we are 6 people", ok({ set: { guests: { min: 6, max: 6 } } })).set.guests, { min: 6 });
    check("…also when 'only' is in the message", normaliseExact("only 6 of us", ok({ set: { guests: { min: 6, max: 6 } } })).set.guests, { min: 6 });
    check("'exactly 4 bedrooms' is one typed number filling both ends (found by the backend rig)", crossCheck("stays in jaipur with exactly 4 bedrooms", ok({ set: { place: "jaipur", bedrooms: { min: 4, max: 4 } } }), "2026-11-25", {}), null);
    check("…a number used for two different fields is still caught", crossCheck("villa in goa for 4", ok({ set: { place: "goa", propertyType: "villa", guests: { min: 4 }, bedrooms: { min: 4 } } }), "2026-11-25", {}), "numbers");
    // found by the model benchmark on the dev set (2026-11-26)
    check("a child's age is not a requirement number", numbersIn("ghar ke 3 log hain (2 bade aur ek 7 saal ka bachha)").required, [3, 2]);
    check("…'5 year old' too", numbersIn("2 adults and a 5 year old").required, [2]);
    check("'5 hazaar se zyada, 9 hazaar se kam' is a 5000-9000 range", crossCheck("5 hazaar se zyada, 9 hazaar se kam", ok({ set: { price: { min: 5000, max: 9000 } } }), "2026-11-25", {}), null);
    check("…'5 hazaar se zyada' read as a ceiling is caught", crossCheck("5 hazaar se zyada", ok({ set: { price: { max: 5000 } } }), "2026-11-25", {}), "budget_direction");
    check("'10k tak' is a ceiling", crossCheck("goa mein villa 10k tak", ok({ set: { place: "goa", propertyType: "villa", price: { max: 10000 } } }), "2026-11-25", {}), null);
    // people added to the group (golden/README: "one more person is joining" → guests + 1)
    check("'ek aur dost aa raha hai' after 4 guests → 5 is accounted for", crossCheck("ek aur dost aa raha hai", ok({ set: { guests: { min: 5 } } }), "2026-11-25", { place: "alibaug", propertyType: "villa", guests: { min: 4 } }), null);
    check("'one more friend is joining' after 4 → 5", crossCheck("one more friend is joining", ok({ set: { guests: { min: 5 } } }), "2026-11-25", { place: "alibaug", propertyType: "villa", guests: { min: 4 } }), null);
    check("'2 more people' after 4 → 6", crossCheck("2 more people", ok({ set: { guests: { min: 6 } } }), "2026-11-25", { place: "alibaug", propertyType: "villa", guests: { min: 4 } }), null);
    check("'2 bacche bhi aa rahe hain' after 4 → 6", crossCheck("2 bacche bhi aa rahe hain", ok({ set: { guests: { min: 6 } } }), "2026-11-25", { place: "alibaug", propertyType: "villa", guests: { min: 4 } }), null);
    check("…a wrong sum is still caught (4 + 1 read as 7)", crossCheck("ek aur dost aa raha hai", ok({ set: { guests: { min: 7 } } }), "2026-11-25", { place: "alibaug", propertyType: "villa", guests: { min: 4 } }), "numbers");
    check("…no earlier head count: nothing to add to, caught", crossCheck("ek aur dost aa raha hai", ok({ set: { guests: { min: 5 } } }), "2026-11-25", {}), "numbers");
    check("…no 'more / aur / bhi' phrase: an invented 5 is caught", crossCheck("dost aa raha hai", ok({ set: { guests: { min: 5 } } }), "2026-11-25", { place: "alibaug", propertyType: "villa", guests: { min: 4 } }), "numbers");
    check("…'2 more people' read as 2 guests is a plain typed number (not this rule)", crossCheck("2 more people", ok({ set: { guests: { min: 2 } } }), "2026-11-25", { place: "alibaug", propertyType: "villa", guests: { min: 4 } }), null);
    check("…read as a floor it is caught", crossCheck("goa mein villa 10k tak", ok({ set: { place: "goa", propertyType: "villa", price: { min: 10000 } } }), "2026-11-25", {}), "budget_direction");
    check("'12 हज़ार से ज़्यादा नहीं' is a ceiling", crossCheck("बजट 12 हज़ार से ज़्यादा नहीं", ok({ set: { price: { max: 12000 } } }), "2026-11-25", {}), null);
    check("…also with the precomposed letter", crossCheck("बजट 12 हज़ार से ज़्यादा नहीं", ok({ set: { price: { max: 12000 } } }), "2026-11-25", {}), null);
    check("'12k se zyada nahi' is a ceiling", crossCheck("12k se zyada nahi", ok({ set: { price: { max: 12000 } } }), "2026-11-25", {}), null);
    check("'3 log (2 bade aur ek baccha)': total plus breakdown", crossCheck("colva mein rukna hai, ghar ke 3 log hain (2 bade aur ek 7 saal ka baccha), wifi aur kitchen hona chahiye", ok({ set: { place: "colva", guests: { min: 3 }, amenitiesAll: ["wifi", "kitchen"] } }), "2026-11-25", {}), null);
    check("…but a dropped '2 bedrooms' next to a total is still caught", crossCheck("villa in goa for 3 people with 2 bedrooms and 1 bathroom", ok({ set: { place: "goa", propertyType: "villa", guests: { min: 3 }, bathrooms: { min: 1 } } }), "2026-11-25", {}), "numbers");
    check("'pata nahi, bas kitchen' does not negate the kitchen", crossCheck("budget ka abhi pata nahi, bas kitchen hona chahiye", ok({ set: { amenitiesAll: ["kitchen"] } }), "2026-11-25", { place: "goa" }), null);
    check("'budget ki koi chinta nahi' removes the budget (a removal phrase, not a suspicious drop)", crossCheck("budget ki koi chinta nahi", ok({ unset: ["price"] }), "2026-11-25", { place: "lucknow", guests: { min: 3 }, placeType: "room", price: { max: 4000 }, amenitiesAll: ["air-conditioning"] }), null);
    check("'बजट की कोई चिंता नहीं' removes the budget", crossCheck("बजट की कोई चिंता नहीं", ok({ unset: ["price"] }), "2026-11-25", { place: "lucknow", guests: { min: 3 }, placeType: "room", price: { max: 4000 }, amenitiesAll: ["air-conditioning"] }), null);
    check("'budget ka pata nahi' is not a negation", hasNegation("budget ka abhi pata nahi, bas kitchen hona chahiye"), false);
    check("…a real 'nahi' next to it still is", hasNegation("budget ka pata nahi, pool nahi chahiye"), true);
    check("'बजट हटा दो' may remove the budget", crossCheck("बजट हटा दो", ok({ unset: ["price"] }), "2026-11-25", { price: { max: 18000 } }), null);
    for (const m of ["reset pls", "let's start fresh", "start from scratch", "please start over", "phir se shuru karo"]) check(`'${m}' resets without a model`, fastPath(m, false), { kind: "reset" });
    check("'reset the budget' is not a full reset", fastPath("reset the budget", false), null);
    {
      const prevDates: SearchState = { place: "goa", checkIn: "2026-11-26", checkOut: "2026-11-29" };
      const len = (msg: string, o: Record<string, unknown>) => { const g = applyGuards(msg, ok(o), prevDates, "2026-11-25"); return [g.set.checkIn, g.set.checkOut, g.nights]; };
      check("'make it 4 nights' with dates set keeps check-in (model moved the wrong end)", len("make it 4 nights", { set: { checkIn: "2026-11-25", checkOut: "2026-11-29" } }), ["2026-11-26", "2026-11-30", undefined]);
      check("…read as a bare length, it becomes dates", len("make it 4 nights", { nights: 4 }), ["2026-11-26", "2026-11-30", undefined]);
      check("'teen raat' works the same", len("teen raat kar do", { nights: 3 }), ["2026-11-26", "2026-11-29", undefined]);
      check("a written date wins over the length", len("5 to 9 dec, 4 nights", { set: { checkIn: "2026-12-05", checkOut: "2026-12-09" } }), ["2026-12-05", "2026-12-09", undefined]);
      check("a length the model did not read is left to the checks", len("make it 4 nights", {}), [undefined, undefined, undefined]);
      check("no dates yet: a length stays a length", applyGuards("for 3 nights", ok({ nights: 3 }), { place: "goa" }, "2026-11-25").nights, 3);
    }
    check("a guest range is untouched", normaliseExact("4 to 6 people", ok({ set: { guests: { min: 4, max: 6 } } })).set.guests, { min: 4, max: 6 });
    check("a requirement placed beside \"set\" is still read", ok({ set: { place: "goa" }, amenitiesAll: ["pool"], guests: { min: 4 } }).set, { place: "goa", guests: { min: 4 }, amenitiesAll: ["pool"] });

    // cross-checks
    const cc = (msg: string, o: Record<string, unknown>) => crossCheck(msg, ok(o), today);
    check("consistent reading", cc("villa in goa for 8 under 10k", { set: { place: "goa", guests: { min: 8 }, price: { max: 10000 } } }), null);
    check("a typed number was dropped", cc("villa for 8 under 10k", { set: { guests: { min: 8 } } }), "numbers");
    check("a number was invented", cc("villa in goa", { set: { guests: { min: 4 } } }), "numbers");
    check("wrong magnitude", cc("under 10k", { set: { price: { max: 1000 } } }), "numbers");
    check("adults + kids add up", cc("2 adults and 2 kids in goa", { set: { place: "goa", guests: { min: 4 } } }), null);
    check("infants are accounted for separately", cc("2 adults 1 infant", { set: { guests: { min: 2 } }, infants: 1 }), null);
    check("Hinglish word numbers", cc("aath log ke liye das hazaar ke andar goa mein villa", { set: { place: "goa", guests: { min: 8 }, price: { max: 10000 }, propertyType: "villa" } }), null);
    check("4BHK → bedrooms", cc("4bhk villa", { set: { bedrooms: { min: 4 }, propertyType: "villa" } }), null);
    check("a number inside the place name", cc("stays in sector 17 chandigarh", { set: { place: "sector 17 chandigarh" } }), null);
    check("date numbers are used by the dates", cc("goa 24 to 27 dec", { set: { place: "goa", checkIn: "2026-12-24", checkOut: "2026-12-27" } }), null);
    check("'3 nights from 24 dec'", cc("3 nights from 24 dec", { set: { checkIn: "2026-12-24", checkOut: "2026-12-27" } }), null);
    check("nights without a start date", cc("goa for 3 nights", { set: { place: "goa" }, nights: 3 }), null);
    check("an ordinal is used by the target", cc("show the 2nd one with a pool", { set: { amenitiesAll: ["pool"] }, target: { ordinals: [2] } }), null);

    check("dates need a time word", cc("villa in goa", { set: { place: "goa", checkIn: "2026-12-24", checkOut: "2026-12-27" } }), "dates_no_cue");
    check("past dates", cc("from 20 nov to 22 nov", { set: { checkIn: "2026-11-20", checkOut: "2026-11-22" } }), "dates_past");
    check("checkout not after check-in", cc("24 dec to 24 dec", { set: { checkIn: "2026-12-24", checkOut: "2026-12-24" } }), "dates_order");
    check("only one date", cc("from 24 dec", { set: { checkIn: "2026-12-24" } }), "dates_half");
    check("an impossible date", cc("30 feb to 2 mar", { set: { checkIn: "2027-02-30", checkOut: "2027-03-02" } }), "dates_invalid");

    check("per-person budget is not converted", cc("5000 per person", { set: { price: { max: 5000 } }, priceBasis: "person" }), "budget_basis");
    check("total budget caught even if the model says nightly", cc("50k total", { set: { price: { max: 50000 } } }), "budget_basis");
    check("a negation must remove something", cc("villa in goa without pool", { set: { place: "goa", amenitiesAll: ["pool"] } }), "negation");
    check("negation → exclusion is fine", cc("villa in goa without pool", { set: { place: "goa", amenitiesNone: ["pool"] } }), null);
    check("negation → unset is fine", cc("no budget limit", { unset: ["price"] }), null);
    check("non-search intents skip the number check", crossCheck("is check-in at 2 pm?", ok({ intent: "listing_question", ask: ["checkin"] }), today), null);

    // merge: the newest instruction wins
    const step = (s: SearchState, o: Record<string, unknown>) => applyDelta(s, ok(o));
    let s: SearchState = {};
    s = step(s, { set: { place: "south goa", guests: { min: 8 }, propertyType: "villa" } });
    s = step(s, { set: { price: { max: 10000 } } });
    s = step(s, { set: { amenitiesAll: ["pool"] }, unsupported: ["private pool"] });
    s = step(s, { set: { place: "north goa" } });
    check("add, add, add, replace the place — everything else kept", s,
      { place: "north goa", guests: { min: 8 }, propertyType: "villa", price: { max: 10000 }, amenitiesAll: ["pool"], unsupported: ["private pool"] });
    check("replace a number", step(s, { set: { guests: { min: 6 } } }).guests, { min: 6 });
    check("drop the budget", "price" in step(s, { unset: ["price"] }), false);
    check("remove one amenity and its unsupported twin", step(s, { remove: ["pool", "Private Pool"] }), { place: "north goa", guests: { min: 8 }, propertyType: "villa", price: { max: 10000 } });
    check("amenities add up", step(s, { set: { amenitiesAll: ["wifi"] } }).amenitiesAll, ["pool", "wifi"]);
    check("'no pool' after 'with pool' flips it", [step(s, { set: { amenitiesNone: ["pool"] } }).amenitiesAll, step(s, { set: { amenitiesNone: ["pool"] } }).amenitiesNone], [undefined, ["pool"]]);
    check("reset clears everything, then applies", step(s, { reset: true, set: { place: "jaipur" } }), { place: "jaipur" });
    check("unset dates clears both", step({ place: "goa", checkIn: "2026-12-24", checkOut: "2026-12-27" }, { unset: ["dates"] }), { place: "goa" });
    check("nights wait for a start date", step({}, { nights: 3 }), { nights: 3 });
    check("dates replace a bare night count", step({ nights: 3 }, { set: { checkIn: "2026-12-24", checkOut: "2026-12-27" } }), { checkIn: "2026-12-24", checkOut: "2026-12-27" });
    check("the previous state is not mutated", s.place, "north goa");
    const again = ok({ set: { guests: { min: 8 } } });
    check("the same message twice is idempotent", applyDelta(applyDelta(s, again), again), applyDelta(s, again));

    // echoes of the state are not changes
    const echoed = stripRestated(ok({ set: { place: "north goa", guests: { min: 8 }, price: { max: 8000 } } }), s);
    check("restated values are dropped from the delta", echoed.set, { price: { max: 8000 } });
    check("…so an echo cannot fail the number check", crossCheck("make it 8000", echoed, today), null);

    const dated: SearchState = { place: "goa", guests: { min: 6 }, checkIn: "2026-12-28", checkOut: "2026-12-31" };
    const echoNights = stripRestated(ok({ set: { guests: { min: 8 } }, nights: 3 }), dated);
    check("an echoed length of stay is dropped", echoNights.nights, undefined);
    check("…so 'we are 8 now' is read as a change of guests, not a number puzzle", crossCheck("we are 8 now", echoNights, today, dated), null);
    check("a NEW length of stay is kept", stripRestated(ok({ nights: 5 }), dated).nights, 5);

    // stored state is re-checked on reuse
    check("yesterday's dates are dropped on reuse", revalidate({ place: "goa", checkIn: "2026-11-20", checkOut: "2026-11-22" }, today), { state: { place: "goa" }, droppedDates: true });
    check("valid dates are kept", revalidate({ checkIn: "2026-12-24", checkOut: "2026-12-27" }, today).droppedDates, false);

    // fast paths: whole-message only
    check("hi", fastPath("Hi!", false), { kind: "greeting" });
    check("thanks", fastPath("thank you", false), { kind: "thanks" });
    check("a search that starts with hi is NOT a greeting", fastPath("hi, villas in goa?", false), null);
    check("new search", fastPath("start over", false), { kind: "reset" });
    check("yes answers a pending question", fastPath("yes", true), { kind: "consent", yes: true });
    check("haan", fastPath("haan", true), { kind: "consent", yes: true });
    check("no answers a pending question", fastPath("nahi", true), { kind: "consent", yes: false });
    check("yes with nothing pending goes to the model", fastPath("yes", false), null);
    check("ok with nothing pending is just thanks", fastPath("ok", false), { kind: "thanks" });
    check("a short place name goes to the model", fastPath("Goa", false), null);
    check("a bare number goes to the model", fastPath("2", false), null);

    const input = JSON.parse(understandInput({ message: "under 10k", state: { place: "goa", shownIds: ["x"], consentFor: "y" }, pending: null, shownCount: 1, today }));
    check("the model sees requirements, not internals", input.state, { place: "goa" });
    check("the model is told India's date and weekday", [input.today, input.weekday], ["2026-11-25", "Wednesday"]);
  });

  await group("pipeline", async () => {
    const saved = (name: string) => JSON.parse(readFileSync(`eval/contract/${name}.json`, "utf8")) as { status: number; body: { data: Listing[] } };
    const goa = saved("place-goa").body.data;
    const FILES: Record<string, string> = { goa: "place-goa", "north goa": "place-goa", panaji: "nearby-panaji", hills: "vague-hills", mumbay: "corrected-mumbay", "": "all-limit50", broken: "bad-number" };

    // A scripted "model": the reading for each message is fixed, so these checks
    // are about the pipeline, not about a model.
    const world = (script: Record<string, unknown>) => {
      let clock = new Date("2026-11-25T06:00:00Z").getTime();
      const store = memoryStore();
      const calls = { llm: 0, catalog: [] as string[] };
      const deps: PipelineDeps = {
        now: () => new Date(clock),
        store,
        catalog: {
          baseUrl: "https://api.example/api/v1",
          fetch: (async (url: string | URL) => {
            const u = new URL(String(url));
            const place = (u.searchParams.get("location") ?? "").toLowerCase();
            calls.catalog.push(u.search);
            const f = saved(u.searchParams.get("from") && place === "goa" ? "dated-goa" : FILES[place] ?? "vague-hills");
            return Response.json(f.body, { status: f.status });
          }) as typeof fetch,
        },
        llm: async (_s, user) => {
          calls.llm++;
          const msg = JSON.parse(user).message as string;
          const json = script[msg];
          if (json === "FAIL") return { ok: false, why: "failed", attempts: 2, errors: ["x"] };
          if (json === "CAP") return { ok: false, why: "cap", attempts: 0, errors: [] };
          return { ok: true, json, provider: "gemini", tokensIn: 900, tokensOut: 120, attempts: 1 } as LlmResult;
        },
      };
      const never = new AbortController().signal;
      return {
        store, calls, deps,
        tick: (ms: number) => { clock += ms; },
        say: (message: string, key: string | null = "g:g_11111111-aaaa") => handleTurn({ message, key }, deps, never),
      };
    };
    const S = (o: Record<string, unknown>) => ({ intent: "search", ...o });
    const ids = (r: Reply) => r.cards.map((c) => c._id);

    // The conversation from the brief, on real listing data.
    const villas8 = goa.filter((l) => l.propertyType === "villa" && (l.guests ?? 0) >= 8);
    let w = world({
      "villas in goa for 8": S({ set: { place: "goa", guests: { min: 8 }, propertyType: "villa" } }),
      "under 10000": S({ set: { price: { max: 10000 } } }),
      "any budget, but private pool": S({ unset: ["price"], set: { amenitiesAll: ["pool"] }, unsupported: ["private pool"] }),
      "actually panaji": S({ set: { place: "panaji" } }),
    });
    let r = await w.say("villas in goa for 8");
    check("turn 1: confirmed matches only", [r.outcome, ids(r).sort()], ["matches", villas8.slice(0, 8).map((l) => l._id).sort()]);
    check("turn 1: every card is a villa that sleeps 8+", r.cards.every((c) => c.propertyType === "villa" && (c.guests ?? 0) >= 8), true);
    check("turn 1: the filters are shown back first", r.text.split("\n")[0], "Goa · 8 guests · villa");
    check("turn 1: no dates → no availability claim", [r.cards.some((c) => c.availability), /Add your dates/.test(r.text)], [false, true]);
    check("turn 1: only place and dates went to the API", w.calls.catalog, ["?location=goa&limit=50&page=1"]);

    r = await w.say("under 10000");
    const cheapest = Math.min(...villas8.map((l) => l.basePrice!));
    check("turn 2: the budget is added, nothing else lost", w.store.docs.get("g:g_11111111-aaaa")!.state,
      { place: "goa", guests: { min: 8 }, propertyType: "villa", price: { max: 10000 } });
    check("turn 2: honest no-match with the exact blocker", [r.outcome, r.cards.length, r.text.includes(`everything except the budget, from ₹${cheapest.toLocaleString("en-IN")} a night`)], ["no_match", 0, true]);

    r = await w.say("any budget, but private pool");
    const poolVillas8 = villas8.filter((l) => l.amenities?.includes("pool"));
    check("turn 3: unverifiable requirement → ask first, show nothing", [r.outcome, r.cards.length, r.pending?.kind, r.text.includes(`can't verify "private pool"`)], ["possible_ask", 0, "consent", true]);
    const llmBefore = w.calls.llm;
    r = await w.say("yes");
    check("turn 4: 'yes' needs no model call", w.calls.llm, llmBefore);
    check("turn 4: shown as NOT verified, never as matches", [r.outcome, r.cards.length, r.cards.every((c) => c.group === "possible" && c.note === "not verified: private pool"), /stays? match/.test(r.text)],
      ["possible_shown", Math.min(8, poolVillas8.length), true, false]);

    r = await w.say("actually panaji");
    check("turn 5: place replaced, the rest kept", (({ place, guests, propertyType, amenitiesAll, unsupported }) => ({ place, guests, propertyType, amenitiesAll, unsupported }))(w.store.docs.get("g:g_11111111-aaaa")!.state),
      { place: "panaji", guests: { min: 8 }, propertyType: "villa", amenitiesAll: ["pool"], unsupported: ["private pool"] });
    check("turn 5: widened rows are never matches", r.cards.every((c) => c.group !== "match"), true);

    // Widened place, no unverifiable requirement: labelled alternatives with distance.
    w = world({ "stays in panaji": S({ set: { place: "panaji" } }) });
    r = await w.say("stays in panaji");
    check("Panaji: alternatives, labelled with distance", [r.outcome, r.cards.length, r.cards.every((c) => c.group === "alternative" && /km from Panaji$/.test(c.note ?? "")), r.text.includes("No stays in Panaji itself")], ["nearby", 8, true, true]);

    w = world({
      "stays in hills": S({ set: { place: "hills" } }),
      "stays in mumbay": S({ set: { place: "mumbay" } }),
      "stays in broken": S({ set: { place: "broken" } }),
      "goa 24 to 27 dec": S({ set: { place: "goa", checkIn: "2026-12-24", checkOut: "2026-12-27" } }),
    });
    r = await w.say("stays in hills");
    check("vague place → ask, show nothing", [r.outcome, r.cards.length], ["unrecognised_place", 0]);
    r = await w.say("stays in mumbay");
    check("typo corrected, nothing there → said plainly", [r.outcome, r.text.includes("Showing results for Mumbai"), r.text.includes("don't have stays in Mumbai")], ["nearby_none", true, true]);
    r = await w.say("stays in broken");
    check("API failure is 'unavailable', never 'no stays'", [r.outcome, /no stays|nothing matches/i.test(r.text)], ["unavailable", false]);
    check("…and what the customer asked is kept for the retry", w.store.docs.get("g:g_11111111-aaaa")!.state.place, "broken");
    r = await w.say("goa 24 to 27 dec");
    check("dated search: availability only from this turn's dated call", [r.outcome, r.cards.every((c) => c.availability === "available"), r.text.includes("Available for your dates when checked just now, confirmed at checkout."), r.text.split("\n")[0]], ["matches", true, true, "Goa · 24–27 Dec"]);
    check("dated search sent both dates", w.calls.catalog.at(-1), "?location=goa&from=2026-12-24&to=2026-12-27&limit=50&page=1");

    // Understanding failures fail closed.
    w = world({
      "villas in goa for 8": S({ set: { place: "goa", guests: { min: 8 } } }),
      "could you keep it under 10k if possible": S({ set: { price: { max: 1000 } } }),
      "garbled": "not json at all",
      "down": "FAIL",
      "capped": "CAP",
      "what's your refund policy": { intent: "policy", policyTopic: "refund" },
      "cancel my booking": { intent: "booking_management" },
      "best time to visit goa": { intent: "travel_info" },
      "tell me a joke": { intent: "other" },
      "is it nice? also 6 guests": { intent: "other", set: { guests: { min: 6 } } },
    });
    await w.say("villas in goa for 8");
    const before = JSON.stringify(w.store.docs.get("g:g_11111111-aaaa")!.state); // the requirements; the version moves when a turn is acknowledged
    r = await w.say("could you keep it under 10k if possible"); // not a simple message: the model reads it, wrongly
    check("misread number → clarify", r.outcome, "clarify");
    check("…and the requirements are untouched", JSON.stringify(w.store.docs.get("g:g_11111111-aaaa")!.state), before);
    // an answer we can't use is "not understood" (rephrase); a failed call is "not processed" (try again)
    check("unusable model output → not understood, no search; failed call → not processed", [(await w.say("garbled")).outcome, (await w.say("down")).outcome, (await w.say("capped")).outcome], ["other", "not_processed", "busy"]);
    check("…and the requirements are still untouched", JSON.stringify(w.store.docs.get("g:g_11111111-aaaa")!.state), before);
    check("…requirements still untouched", JSON.stringify(w.store.docs.get("g:g_11111111-aaaa")!.state), before);
    // (a short message may be looked up as a place name; that is a lookup, not a search)
    check("policy / booking / travel / other get fixed text and no cards", [
      (await w.say("what's your refund policy")).outcome, (await w.say("cancel my booking")).outcome,
      (await w.say("best time to visit goa")).outcome, (await w.say("tell me a joke")).outcome], ["policy", "support", "travel_off", "other"]);
    check("…and none of them changed the search", JSON.stringify(w.store.docs.get("g:g_11111111-aaaa")!.state), before);
    check("policy text carries no figures", /\d/.test((await w.say("what's your refund policy")).text.replace(/https?:\S+/g, "")), false);
    r = await w.say("is it nice? also 6 guests");
    check("a message that changes the search is a search, whatever the model called it", [r.outcome === "matches" || r.outcome === "no_match", w.store.docs.get("g:g_11111111-aaaa")!.state.guests], [true, { min: 6 }]);

    // Fast paths, reset, expiry, identity.
    w = world({ "villas in goa for 8": S({ set: { place: "goa", guests: { min: 8 } } }), "with pool": S({ set: { amenitiesAll: ["pool"] } }) });
    check("greeting: fixed text, no model, no search", [(await w.say("hi")).outcome, w.calls.llm, w.calls.catalog.length], ["greeting", 0, 0]);
    await w.say("villas in goa for 8");
    check("another guest starts empty", (await w.say("with pool", "g:g_22222222-bbbb")).text.split("\n")[0], "pool");
    check("…and did not touch the first guest", w.store.docs.get("g:g_11111111-aaaa")!.state.amenitiesAll, undefined);
    check("no identity → works, remembers nothing", [(await w.say("villas in goa for 8", null)).outcome, w.store.docs.size], ["matches", 2]);
    r = await w.say("start over");
    check("reset clears the state", [r.outcome, w.store.docs.get("g:g_11111111-aaaa")!.state], ["reset", {}]);
    await w.say("villas in goa for 8");
    w.tick(IDLE_MS + 1000);
    r = await w.say("with pool");
    check("after 30 idle minutes: a fresh search, said plainly", [r.text.split("\n").slice(0, 2), w.store.docs.get("g:g_11111111-aaaa")!.state.place], [["Starting a fresh search.", "pool"], undefined]);

    // Two instances: another commit lands between this turn's read and its write.
    w = world({ "villas in goa for 8": S({ set: { place: "goa", guests: { min: 8 } } }), "with pool": S({ set: { amenitiesAll: ["pool"] } }) });
    await w.say("villas in goa for 8");
    const inner = w.deps.store;
    let raced = false;
    const racing: StateStore = {
      load: (k) => inner.load(k),
      commit: async (k, rev, next) => {
        if (!raced) { raced = true; const d = (await inner.load(k))!; await inner.commit(k, d.rev, { ...d, state: { ...d.state, price: { max: 50000 } } }); }
        return inner.commit(k, rev, next);
      },
    };
    w.deps.store = racing;
    r = await w.say("with pool");
    check("version conflict: nothing is overwritten — both changes survive", [r.outcome, (({ place, guests, price, amenitiesAll }) => ({ place, guests, price, amenitiesAll }))(w.store.docs.get("g:g_11111111-aaaa")!.state)],
      ["retry", { place: "goa", guests: { min: 8 }, price: { max: 50000 }, amenitiesAll: ["pool"] }]);

    // Identity keys.
    check("user key", stateKey("65a1b2c3d4e5f6a7b8c9d0e1", "g_11111111-aaaa"), "u:65a1b2c3d4e5f6a7b8c9d0e1");
    check("guest key", stateKey(null, "g_11111111-aaaa"), "g:g_11111111-aaaa");
    check("a forged guest id gets no state", [stateKey(null, "u:65a1b2c3d4e5f6a7b8c9d0e1"), stateKey(null, "admin"), stateKey(null, "g_x")], [null, null, null]);
    check("a malformed user id gets no state", stateKey("{$ne:null}", null), null);

    // The final validator catches a reply that disagrees with its evidence.
    w = world({ "villas in goa for 8": S({ set: { place: "goa", guests: { min: 8 }, propertyType: "villa" } }) });
    const good = await w.say("villas in goa for 8");
    const cat = await fetchCandidates({ place: "goa" }, w.deps.catalog, new AbortController().signal);
    const st: SearchState = { place: "goa", guests: { min: 8 }, propertyType: "villa" };
    const ev = { state: st, catalog: cat, decision: cat.kind === "ok" ? decide(cat.rows, st) : null };
    check("a correct reply has no defects", validateReply(good, ev), []);
    const tamper = (f: (r: Reply) => void) => { const c = structuredClone(good) as Reply; f(c); return validateReply(c, ev).length > 0; };
    const excluded = goa.find((l) => (l.guests ?? 0) < 8)!;
    check("validator: a wrong price", tamper((c) => { c.cards[0]!.basePrice += 1; }), true);
    check("validator: a card for an excluded stay", tamper((c) => { c.cards[0]!._id = excluded._id; }), true);
    check("validator: an invented stay", tamper((c) => { c.cards[0]!._id = "ffffffffffffffffffffffff"; }), true);
    check("validator: availability without dates", tamper((c) => { c.cards[0]!.availability = "available"; }), true);
    check("validator: an amount not in the evidence", tamper((c) => { c.text += "\nFrom ₹1,234 a night."; }), true);
    check("validator: mixed groups", tamper((c) => { c.cards[0]!.group = "alternative"; }), true);
    check("validator: a renamed stay", tamper((c) => { c.cards[0]!.title = "Totally Different Villa"; }), true);
  });

  await group("guards", () => {
    const P = (o: Record<string, unknown>): Proposal => {
      const p = validateProposal({ intent: "search", ...o });
      if (!p || typeof p === "string") throw new Error("bad proposal");
      return p;
    };
    const g = (msg: string, o: Record<string, unknown>, prev: SearchState = {}) => applyGuards(msg, P(o), prev, "2026-11-25");
    // A guard never deletes a requirement the model read (the first version did, and
    // an independent review showed stays then matched against what was asked).
    check("a switch requirement with no obvious cue word is KEPT ('bringing our puppy')", g("villa in goa, we are bringing our puppy", { set: { place: "goa", petsAllowed: true } }).set.petsAllowed, true);
    check("…'the complete villa to ourselves'", g("the complete villa to ourselves", { set: { placeType: "entire" } }).set.placeType, "entire");
    check("…Hindi पूरी विला", g("पूरी विला चाहिए", { set: { placeType: "entire" } }).set.placeType, "entire");
    check("…'in case plans change'", g("flexible policy in case plans change", { set: { cancellation: "flexible" } }).set.cancellation, "flexible");
    check("an unverifiable label is never removed by a guard ('exclusive pool' → private pool)", g("an exclusive pool just for us", { set: { amenitiesAll: ["pool"] }, unsupported: ["private pool"] }).unsupported, ["private pool"]);
    check("a Devanagari echo of a required amenity is recognised", P({ set: { amenitiesAll: ["pool"] }, unsupported: ["पूल वाला"] }).unsupported, []);
    check("a Devanagari must-have is kept, not mistaken for an echo", P({ set: { place: "goa" }, unsupported: ["समुद्र का नज़ारा"] }).unsupported, ["समुद्र का नज़ारा"]);
    check("a long must-have is cut, not dropped", P({ unsupported: ["ground floor bedroom for my mother who cannot climb stairs at all anymore"] }).unsupported.length, 1);
    check("a must-have nested inside \"set\" is still read", P({ set: { place: "goa", unsupported: ["sea view"] } }).unsupported, ["sea view"]);
    check("\"amenities\" inside \"set\" is read as required amenities", P({ set: { amenities: ["pool"] } }).set.amenitiesAll, ["pool"]);
    check("an unknown key inside \"set\" refuses the whole reading", validateProposal({ intent: "search", set: { place: "goa", seaFacing: true } }), null);
    check("other unsupported labels are never touched", g("villa with sea view", { unsupported: ["sea view"] }).unsupported, ["sea view"]);
    // a year the customer never named
    const dates = (msg: string, checkIn: string, checkOut: string) => { const s = g(msg, { set: { checkIn, checkOut } }).set; return [s.checkIn, s.checkOut]; };
    check("'30 dec to 2 jan' read as 2 Jan this year → next year", dates("goa 30 dec to 2 jan", "2026-12-30", "2026-01-02"), ["2026-12-30", "2027-01-02"]);
    check("'5 to 8 january' read as a January already gone → next year", dates("goa 5 to 8 january", "2026-01-05", "2026-01-08"), ["2027-01-05", "2027-01-08"]);
    check("a year the customer typed is never changed", dates("20 to 22 nov 2026", "2026-11-20", "2026-11-22"), ["2026-11-20", "2026-11-22"]);
    check("correct dates are untouched", dates("24 to 27 dec", "2026-12-24", "2026-12-27"), ["2026-12-24", "2026-12-27"]);
    check("29 Feb cannot be moved to a year without one", dates("28 feb to 29 feb", "2024-02-28", "2024-02-29"), ["2024-02-28", "2024-02-29"]);
    // relative dates: the start day is arithmetic (today is Wednesday 25 Nov 2026)
    check("'this weekend' read as Fri–Sun → Saturday to Monday", dates("goa this weekend for 4", "2026-11-27", "2026-11-29"), ["2026-11-28", "2026-11-30"]);
    check("'this weekend for 3 nights' keeps the stated length", dates("this weekend for 3 nights", "2026-11-27", "2026-11-30"), ["2026-11-28", "2026-12-01"]);
    check("'tomorrow for 2 nights' starts tomorrow", dates("tomorrow for 2 nights in goa", "2026-11-25", "2026-11-27"), ["2026-11-26", "2026-11-28"]);
    check("'kal se 2 raat' starts tomorrow", dates("kal se 2 raat ke liye goa mein room", "2026-11-27", "2026-11-29"), ["2026-11-26", "2026-11-28"]);
    check("'day after tomorrow' is not 'tomorrow'", dates("day after tomorrow for 1 night", "2026-11-26", "2026-11-27"), ["2026-11-27", "2026-11-28"]);
    check("'parso se 2 raat'", dates("parso se 2 raat", "2026-11-26", "2026-11-28"), ["2026-11-27", "2026-11-29"]);
    check("a written date is never overridden by a relative word", dates("this weekend, 5 to 7 dec", "2026-12-05", "2026-12-07"), ["2026-12-05", "2026-12-07"]);
    check("two different anchors: left to the reading", dates("today or tomorrow for 2 nights", "2026-11-25", "2026-11-27"), ["2026-11-25", "2026-11-27"]);
    check("on a Saturday, 'this weekend' starts today", (() => { const s = applyGuards("this weekend", P({ set: { checkIn: "2026-12-04", checkOut: "2026-12-06" } }), {}, "2026-11-28").set; return [s.checkIn, s.checkOut]; })(), ["2026-11-28", "2026-11-30"]);
    // negating something that was required removes it; it does not exclude it
    const had: SearchState = { place: "goa", amenitiesAll: ["pool", "wifi"] };
    const dropped = g("pool nahi chahiye", { set: { amenitiesNone: ["pool"] } }, had);
    check("'pool nahi chahiye' after asking for a pool → requirement removed", [dropped.remove, dropped.set.amenitiesNone], [["pool"], undefined]);
    check("…and the merged state simply no longer asks for it", applyDelta(had, dropped), { place: "goa", amenitiesAll: ["wifi"] });
    check("a fresh 'no pool' is an exclusion", g("villa without a pool", { set: { amenitiesNone: ["pool"] } }).set.amenitiesNone, ["pool"]);
    // an over-broad removal is narrowed to what was named
    const narrowed = g("pool not needed", { unset: ["amenities"] }, had);
    check("'pool not needed' does not wipe every amenity", [narrowed.unset, narrowed.remove], [[], ["pool"]]);
    check("…wifi survives", applyDelta(had, narrowed).amenitiesAll, ["wifi"]);
    check("'no amenities needed' still clears them all", g("no amenities needed", { unset: ["amenities"] }, had).unset, ["amenities"]);
    check("Hinglish glue words do not make an echo look new", P({ set: { amenitiesAll: ["pool"] }, unsupported: ["pool wala"] }).unsupported, []);
  });

  await group("review-regressions", () => {
    // Scenarios from the independent review of 2026-11-25. Each one let a wrong
    // reading through, or stopped a right one.
    const today = "2026-11-25";
    const P = (o: Record<string, unknown>): Proposal => {
      const p = validateProposal({ intent: "search", ...o });
      if (!p || typeof p === "string") throw new Error("bad proposal " + JSON.stringify(p));
      return p;
    };
    const read = (msg: string, o: Record<string, unknown>, prev: SearchState = {}) => {
      const p = stripRestated(normaliseExact(msg, applyGuards(msg, P(o), prev, today)), prev);
      return { p, problem: crossCheck(msg, p, today, prev), next: applyDelta(prev, p) };
    };
    const pooled: SearchState = { place: "goa", amenitiesAll: ["pool"] };

    // exclusion vs "no longer needed"
    check("'without a pool' after asking for one stays an EXCLUSION", read("sorry, I meant without a pool, my kids cannot swim", { set: { amenitiesNone: ["pool"] } }, pooled).next, { place: "goa", amenitiesNone: ["pool"] });
    check("'pool not needed' after asking for one just drops it", read("pool not needed", { set: { amenitiesNone: ["pool"] } }, pooled).next, { place: "goa" });
    check("'and without a pool' read as WITH a pool is refused", read("and without a pool", { set: { amenitiesAll: ["pool"] } }, { place: "goa", amenitiesAll: ["wifi"] }).problem, "negation");
    check("'pool table not needed' removes the pool table, not the pool", read("pool table not needed", { unset: ["amenities"] }, { amenitiesAll: ["pool", "pool-table"] }).next, { amenitiesAll: ["pool"] });

    // removals nobody asked for
    // candidate 3 (2026-11-27): an unrequested removal is DROPPED and the requirement kept (it used to be a
    // clarifying question; heldout3 / heldout4 showed customers replacing one value and getting "what should I leave out?")
    {
      const r = read("what about for 6 people?", { set: { guests: { min: 6 } }, unset: ["unsupported", "price"] }, { place: "goa", price: { max: 10000 }, unsupported: ["private pool"] });
      check("an unrequested removal is dropped, not applied", [r.problem, r.next], [null, { place: "goa", price: { max: 10000 }, unsupported: ["private pool"], guests: { min: 6 } }]);
    }
    check("an asked-for removal is fine", read("forget the budget", { unset: ["price"] }, { place: "goa", price: { max: 10000 } }).problem, null);

    // ranges
    check("'at least 5000' keeps the earlier ceiling", read("at least 5000 though", { set: { price: { min: 5000 } } }, { price: { max: 10000 } }).next.price, { max: 10000, min: 5000 });
    check("a new ceiling replaces the old one", read("make it 4000", { set: { price: { max: 4000 } } }, { price: { max: 5000 } }).next.price, { max: 4000 });
    check("'4 to 6 people' needs room for 6", statusOf({ _id: "x", guests: 4 }, { guests: { min: 4, max: 6 } }, "guests"), "unsatisfied");
    check("'above 10k' read as a ceiling is refused", read("villa in goa above 10k a night", { set: { place: "goa", price: { max: 10000 } } }).problem, "budget_direction");
    check("'under 10k' read as a floor is refused", read("goa under 10k", { set: { place: "goa", price: { min: 10000 } } }).problem, "budget_direction");
    check("'under 10k' read as a ceiling passes", read("goa under 10k", { set: { place: "goa", price: { max: 10000 } } }).problem, null);
    check("'minimum 2 bathrooms, budget 8000' is not a direction clash", read("minimum 2 bathrooms, budget 8000 in goa", { set: { place: "goa", bathrooms: { min: 2 }, price: { max: 8000 } } }).problem, null);

    // numbers: each typed number is used once
    check("guests dropped because 3 equals the night count → refused", read("villa in goa for 3 people, 24 to 27 dec", { set: { place: "goa", propertyType: "villa", checkIn: "2026-12-24", checkOut: "2026-12-27" } }).problem, "numbers");
    check("…the full reading passes", read("villa in goa for 3 people, 24 to 27 dec", { set: { place: "goa", propertyType: "villa", guests: { min: 3 }, checkIn: "2026-12-24", checkOut: "2026-12-27" } }).problem, null);
    check("one of two equal numbers dropped → refused", read("2 bedrooms and 2 bathrooms in manali", { set: { place: "manali", bedrooms: { min: 2 } } }).problem, "numbers");
    check("…both read passes", read("2 bedrooms and 2 bathrooms in manali", { set: { place: "manali", bedrooms: { min: 2 }, bathrooms: { min: 2 } } }).problem, null);
    check("bedrooms dropped behind '2 adults and 2 kids' → refused", read("2 adults and 2 kids, 4 bedrooms, lonavala", { set: { place: "lonavala", guests: { min: 4 } } }).problem, "numbers");
    check("…the full reading passes", read("2 adults and 2 kids, 4 bedrooms, lonavala", { set: { place: "lonavala", guests: { min: 4 }, bedrooms: { min: 4 } } }).problem, null);
    check("repeating a number already in the search is not a puzzle", read("ok under 10k but with a pool", { set: { price: { max: 10000 }, amenitiesAll: ["pool"] } }, { place: "goa", price: { max: 10000 } }).problem, null);
    check("'24,25 dec' is two days, not 2425", numbersIn("goa 24,25 dec for 2 people").required, [24, 25, 2]);
    check("'1,00,000' is still one number", numbersIn("under ₹1,00,000").required, [100000]);

    // dates and budgets
    check("a digit is not a time word: invented dates are refused", read("goa for 4 people under 10k", { set: { place: "goa", guests: { min: 4 }, price: { max: 10000 }, checkIn: "2026-12-24", checkOut: "2026-12-27" } }).problem, "dates_no_cue");
    check("'24/12 to 27/12' is a time word", hasDateCue("goa 24/12 to 27/12"), true);
    check("'30k for 3 nights' is a total, not a nightly budget", read("goa, budget 30k for 3 nights", { set: { place: "goa", price: { max: 30000 } }, nights: 3 }).problem, "budget_basis");
    check("'for 3 nights under 10k' is a nightly budget", hasNonNightlyBudgetCue("goa for 3 nights under 10k"), false);
    check("'total 8 people' is not a budget word", read("we are total 8 people, budget 10k per night in lonavala", { set: { place: "lonavala", guests: { min: 8 }, price: { max: 10000 } } }).problem, null);
    check("a budget of 2000 is not a year", read("goa 5 to 8 jan under 2000", { set: { place: "goa", price: { max: 2000 }, checkIn: "2026-01-05", checkOut: "2026-01-08" } }).p.set.checkIn, "2027-01-05");
    check("a date earlier this month is NOT moved to next year", read("goa 20 to 24 nov", { set: { place: "goa", checkIn: "2026-11-20", checkOut: "2026-11-24" } }).problem, "dates_past");

    // negation that is not about a requirement
    check("'I don't have fixed dates yet' is not a removal", read("I don't have fixed dates yet, show me villas in goa for 6", { set: { place: "goa", propertyType: "villa", guests: { min: 6 } } }).problem, null);
    check("'no smoking inside please' is not a removal", read("no smoking inside please", { unsupported: ["no smoking inside"] }, { place: "goa" }).problem, null);

    // the place is the customer's own word
    check("an invented place is refused", read("something for 4 people", { set: { place: "Goa", guests: { min: 4 } } }).problem, "place");
    check("a place the customer typed passes", read("something in goa for 4 people", { set: { place: "goa", guests: { min: 4 } } }).problem, null);

    // a ₹ inside a must-have must not break the reply
    const st: SearchState = { place: "goa", propertyType: "villa", unsupported: ["breakfast under ₹500"] };
    const cat = { kind: "ok" as const, scope: "place" as const, complete: true, rows: [villa], total: 1, corrected: false, pages: 1 };
    const decision = decide(cat.rows, st);
    const reply = searchReply({ state: st, catalog: cat, decision, today, preface: [] });
    check("a ₹ inside a must-have label does not fail validation", validateReply(reply, { state: st, catalog: cat, decision }), []);
    check("a fractional price is rounded, not rejected", validateReply(searchReply({ state: {}, catalog: { ...cat, rows: [{ ...villa, basePrice: 12499.5 }] }, decision: decide([{ ...villa, basePrice: 12499.5 }], { price: { max: 99999 } }), today, preface: [] }), { state: { price: { max: 99999 } }, catalog: { ...cat, rows: [{ ...villa, basePrice: 12499.5 }] }, decision: decide([{ ...villa, basePrice: 12499.5 }], { price: { max: 99999 } }) }), []);
  });

  await group("review-regressions-flow", async () => {
    const saved = (name: string) => JSON.parse(readFileSync(`eval/contract/${name}.json`, "utf8")) as { status: number; body: { data: Listing[] } };
    const FILES: Record<string, string> = { goa: "place-goa", panaji: "nearby-panaji", "casa feliz": "name-casa-feliz" };
    const make = (script: Record<string, unknown>, emptyWhenDated = false) => {
      const store = memoryStore();
      let llmCalls = 0;
      const deps: PipelineDeps = {
        now: () => new Date("2026-11-25T06:00:00Z"),
        store,
        catalog: {
          baseUrl: "https://api.example/api/v1",
          fetch: (async (url: string | URL) => {
            const u = new URL(String(url));
            const place = (u.searchParams.get("location") ?? "").toLowerCase();
            if (emptyWhenDated && u.searchParams.get("from")) return Response.json({ data: [], pagination: { totalCount: 0 }, search: { mode: "text" } });
            const f = saved(FILES[place] ?? "all-limit50");
            return Response.json(f.body, { status: f.status });
          }) as typeof fetch,
        },
        llm: async (_s, user) => { llmCalls++; return { ok: true, json: script[JSON.parse(user).message as string], provider: "gemini", tokensIn: 0, tokensOut: 0, attempts: 1, ms: 0 }; },
      };
      const key = "g:g_44444444-dddd";
      return { store, deps, key, calls: () => llmCalls, say: (message: string) => handleTurn({ message, key }, deps, new AbortController().signal) };
    };
    const S = (o: Record<string, unknown>) => ({ intent: "search", ...o });

    // consent: real-world yes / no, and a question that goes stale
    let w = make({
      "villa in goa with a private pool": S({ set: { place: "goa", propertyType: "villa", amenitiesAll: ["pool"] }, unsupported: ["private pool"] }),
      "what is your refund policy?": { intent: "policy", policyTopic: "refund" },
      "ok": { intent: "other" },
    });
    check("asks before showing unverifiable stays", (await w.say("villa in goa with a private pool")).outcome, "possible_ask");
    const before = w.calls();
    check("'Yes please' is a yes, with no model call", [(await w.say("Yes please")).outcome, w.calls() - before], ["possible_shown", 0]);
    w = make({
      "villa in goa with a private pool": S({ set: { place: "goa", propertyType: "villa", amenitiesAll: ["pool"] }, unsupported: ["private pool"] }),
      "what is your refund policy?": { intent: "policy", policyTopic: "refund" },
      "ok": { intent: "other" },
    });
    await w.say("villa in goa with a private pool");
    check("'haan dikhao' is a yes", (await w.say("haan dikhao")).outcome, "possible_shown");
    await w.say("start over");
    await w.say("villa in goa with a private pool");
    check("'no thanks' is a no", (await w.say("no thanks")).outcome, "declined");
    await w.say("villa in goa with a private pool");
    await w.say("what is your refund policy?");
    check("a consent question does not survive an unrelated turn", [w.store.docs.get(w.key)!.pending, (await w.say("ok")).outcome], [null, "thanks"]);

    // a question about a shown stay does not become a requirement
    w = make({
      "villas in goa": S({ set: { place: "goa", propertyType: "villa" } }),
      "does the second one have a pool?": { intent: "listing_question", target: { ordinals: [2] }, ask: ["amenities"], set: { amenitiesAll: ["pool"] } },
      "how much is the ninth one?": { intent: "listing_question", target: { ordinals: [9] }, ask: ["price"] },
    });
    await w.say("villas in goa");
    check("'does the second one have a pool?' answers, and adds no requirement", [(await w.say("does the second one have a pool?")).outcome, w.store.docs.get(w.key)!.state.amenitiesAll], ["info", undefined]);
    check("an ordinal past the list asks which stay", (await w.say("how much is the ninth one?")).outcome, "which_stay");

    // widened place + unverifiable requirement: ask, then show as labelled alternatives
    w = make({ "pet friendly stay in panaji": S({ set: { place: "panaji", petsAllowed: true } }) });
    let r = await w.say("pet friendly stay in panaji");
    check("nearby stays that only fail on the unverifiable are offered, not dismissed", [r.outcome, r.cards.length, r.pending?.kind], ["possible_ask", 0, "consent"]);
    r = await w.say("yes");
    check("…and shown as nearby AND not verified", [r.outcome, r.cards.length > 0, r.cards.every((c) => c.group === "alternative" && /km from Panaji · not verified: pets allowed$/.test(c.note ?? ""))], ["nearby", true, true]);
    check("…never worded as matches", /stays? match/.test(r.text), false);

    // a named stay that is simply booked for the dates is not "not found"
    w = make({ "casa feliz 24 to 27 dec": S({ set: { place: "casa feliz", checkIn: "2026-12-24", checkOut: "2026-12-27" } }) }, true);
    r = await w.say("casa feliz 24 to 27 dec");
    check("booked for the dates ≠ does not exist", [r.outcome, r.text.includes("It may be booked then"), /couldn't find a place or a stay called/.test(r.text)], ["name_not_found", true, false]);

    // an unreadable state store: no search, no model call
    w = make({ "villas in goa": S({ set: { place: "goa" } }) });
    w.deps.store = { load: async () => { throw new Error("mongo down"); }, commit: async () => false };
    check("unreadable state → 'couldn't process', and the model is not called", [(await w.say("villas in goa")).outcome, w.calls()], ["not_processed", 0]);

    // contract and configuration edges
    check("more rows than the total it reports is a failure", parsePage(200, { data: [{ _id: "a" }, { _id: "b" }], pagination: { totalCount: 1 }, search: { mode: "all" } }), "more rows than totalCount");
    const pct = (v: string) => { const old = process.env.RAG_V2_PERCENT; process.env.RAG_V2_PERCENT = v; try { return inCanary("g:g_x"); } finally { if (old === undefined) delete process.env.RAG_V2_PERCENT; else process.env.RAG_V2_PERCENT = old; } };
    check("an unreadable canary percentage means nobody, not everybody", [pct("10%"), pct("ten")], [false, false]);
    check("rows without a title are not counted as matches to show", searchReply({ state: { place: "x" }, catalog: { kind: "ok", scope: "place", complete: true, rows: [{ _id: "n1", basePrice: 5000 }], total: 1, corrected: false, pages: 1 }, decision: decide([{ _id: "n1", basePrice: 5000 }], { place: "x" }), today: "2026-11-25", preface: [] }).outcome, "no_match");
  });

  await group("inquire", async () => {
    const saved = (name: string) => JSON.parse(readFileSync(`eval/contract/${name}.json`, "utf8")) as { status: number; body: { data: Listing[] } };
    const goa = saved("place-goa").body.data;
    const datedIds = new Set(saved("dated-goa").body.data.map((l) => l._id));
    const booked = goa.find((l) => !datedIds.has(l._id))!; // in Goa, not free for the recorded dates
    let failing = false;
    const store = memoryStore();
    const script: Record<string, unknown> = {
      "stays in goa": { intent: "search", set: { place: "goa" } },
      "goa 24 to 27 dec": { intent: "search", set: { place: "goa", checkIn: "2026-12-24", checkOut: "2026-12-27" } },
      "does the second one have a pool?": { intent: "listing_question", target: { ordinals: [2] }, ask: ["amenities"] },
      "compare the first two": { intent: "compare", target: { ordinals: [1, 2] } },
      "how much is casa feliz": { intent: "listing_question", target: { names: ["casa feliz"] }, ask: ["price"] },
      "is the first one free?": { intent: "listing_question", target: { ordinals: [1] }, ask: ["availability"] },
      "what time is check in?": { intent: "listing_question", ask: ["checkin"] },
    };
    const deps: PipelineDeps = {
      now: () => new Date("2026-11-25T06:00:00Z"),
      store,
      catalog: {
        baseUrl: "https://api.example/api/v1",
        fetch: (async (url: string | URL) => {
          if (failing) return new Response("{}", { status: 500 });
          const u = new URL(String(url));
          const place = (u.searchParams.get("location") ?? "").toLowerCase();
          const f = saved(place === "casa feliz" ? "name-casa-feliz" : u.searchParams.get("from") ? "dated-goa" : "place-goa");
          return Response.json(f.body, { status: f.status });
        }) as typeof fetch,
      },
      llm: async (_s, user) => ({ ok: true, json: script[JSON.parse(user).message as string], provider: "gemini", tokensIn: 0, tokensOut: 0, attempts: 1, ms: 0 }),
    };
    const key = "g:g_33333333-cccc";
    const say = (message: string) => handleTurn({ message, key }, deps, new AbortController().signal);

    check("nothing shown yet → ask which stay", (await say("what time is check in?")).outcome, "which_stay");
    const first = await say("stays in goa");
    const [c1, c2] = first.cards;
    const l2 = goa.find((l) => l._id === c2!._id)!;
    let r = await say("does the second one have a pool?");
    check("answers about the second card, from its own data", [r.outcome, r.cards.length, r.text], ["info", 0, `${l2.title}: amenities listed: ${l2.amenities!.join(", ")}.`]);
    r = await say("compare the first two");
    check("comparison: one line per stay, in order", r.text.split("\n").map((x) => x.split(": ₹")[0]), [c1!.title, c2!.title]);
    check("comparison: each price is the listing's own", [r.text.includes(`₹${c1!.basePrice.toLocaleString("en-IN")} a night, before taxes and fees`), r.text.includes(`₹${c2!.basePrice.toLocaleString("en-IN")} a night`)], [true, true]);
    const feliz = saved("name-casa-feliz").body.data[0]!;
    check("a stay asked for by name", (await say("how much is casa feliz")).text, `${feliz.title}: ₹${feliz.basePrice!.toLocaleString("en-IN")} a night, before taxes and fees.`);
    check("availability without dates is never guessed", (await say("is the first one free?")).text.endsWith(": select dates to check availability."), true);
    check("a question does not change the search", store.docs.get(key)!.state.place, "goa");

    await say("goa 24 to 27 dec");
    check("availability with dates: from this turn's dated search", (await say("is the first one free?")).text.endsWith(": available for your dates when checked just now, confirmed at checkout."), true);
    const d = store.docs.get(key)!;
    d.state.shownIds = [booked._id];
    check("a stay missing from the dated search is unavailable", (await say("is the first one free?")).text, `${booked.title}: unavailable for your selected dates.`);
    failing = true;
    check("lookup failure is said plainly, never answered from memory", (await say("is the first one free?")).outcome, "unavailable");

    const bare = await inquire(
      { intent: "listing_question", reset: false, set: {}, unset: [], remove: [], soft: [], unsupported: [], priceBasis: "night", target: { ordinals: [1], names: [] }, ask: ["checkin", "rules", "cancellation", "capacity"] },
      { place: "x", shownIds: ["Z1"] },
      { baseUrl: "https://api.example/api/v1", fetch: (async () => Response.json({ data: [{ _id: "Z1", title: "Bare Stay" }], pagination: { totalCount: 1 }, search: { mode: "place" } })) as typeof fetch },
      new AbortController().signal
    );
    const kitchenQ = await inquire(
      { intent: "listing_question", reset: false, set: {}, unset: [], remove: [], soft: [], unsupported: [], priceBasis: "night", target: { ordinals: [1], names: [] }, ask: [] } as unknown as Proposal,
      { place: "x", shownIds: ["Z2"] },
      { baseUrl: "https://api.example/api/v1", fetch: (async () => Response.json({ data: [{ _id: "Z2", title: "Kitchen Stay", basePrice: 5000, guests: 4, amenities: ["kitchen", "wifi"] }], pagination: { totalCount: 1 }, search: { mode: "place" } })) as typeof fetch },
      new AbortController().signal,
      "does the first one have a kitchen?"
    );
    check("a question naming an amenity is answered with the amenities, even when the reading did not ask", kitchenQ.kind === "answer" && kitchenQ.text.includes("amenities listed: kitchen, wifi"), true);
    check("missing fields are reported as not stated", bare.kind === "answer" && bare.text,
      "Bare Stay: check-in and check-out times are not stated on the listing; no house rules are listed; cancellation terms are not stated on the listing; capacity not stated on the listing.");
  });

  await group("modes", () => {
    const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
      const old: Record<string, string | undefined> = {};
      for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
      try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
    };
    check("unset → safe: a deploy never switches the new search on by itself", withEnv({ RAG_PIPELINE: undefined }, pipelineMode), "safe");
    check("an unknown value → safe", withEnv({ RAG_PIPELINE: "v1" }, pipelineMode), "safe");
    check("v2", withEnv({ RAG_PIPELINE: "v2" }, pipelineMode), "v2");
    check("shadow", withEnv({ RAG_PIPELINE: "shadow" }, pipelineMode), "shadow");
    const ids = Array.from({ length: 2000 }, (_, i) => `g:g_${i.toString(16).padStart(8, "0")}-abcd`);
    const share = (pct: string | undefined) => withEnv({ RAG_V2_PERCENT: pct }, () => ids.filter(inCanary).length / ids.length);
    check("canary 100 % by default", share(undefined), 1);
    check("canary 0 %", share("0"), 0);
    check("canary 10 % is roughly a tenth", share("10") > 0.06 && share("10") < 0.14, true);
    check("canary is stable per identity", withEnv({ RAG_V2_PERCENT: "50" }, () => inCanary(ids[7]!) === inCanary(ids[7]!)), true);
    check("a 10 % identity stays in at 50 %", withEnv({ RAG_V2_PERCENT: "10" }, () => ids.filter(inCanary)).every((id) => withEnv({ RAG_V2_PERCENT: "50" }, () => inCanary(id))), true);
  });

  // Defects found by the second independent review (2026-11-26), each reproduced first.
  await group("review-2-regressions", async () => {
    const P = (o: Record<string, unknown>): Proposal => {
      const p = validateProposal({ intent: "search", ...o });
      if (!p || typeof p === "string") throw new Error("bad proposal");
      return p;
    };
    const T = "2026-11-25";
    const cc = (msg: string, o: Record<string, unknown>, prev: SearchState = {}) => crossCheck(msg, P(o), T, prev);
    // H1: a leftover that merely adds up to the group is not a breakdown
    check("H1 '6 people including 2 kids, need 4 bedrooms' with bedrooms dropped is refused", cc("goa villa, 6 people including 2 kids, need 4 bedrooms", { set: { place: "goa", propertyType: "villa", guests: { min: 6 } } }), "numbers");
    check("H1 '4 people with kids, 2 bedrooms 2 bathrooms' with both dropped is refused", cc("4 people with kids, 2 bedrooms 2 bathrooms", { set: { guests: { min: 4 } } }), "numbers");
    check("H1 …a real breakdown still passes", cc("4 people, 2 adults and 2 kids, goa", { set: { place: "goa", guests: { min: 4 } } }), null);
    check("H1 …'2 bedrooms for kids' is not a breakdown", cc("4 people, 2 bedrooms for kids, goa", { set: { place: "goa", guests: { min: 4 } } }), "numbers");
    // H2: "se kam nahi" = not less than; "kam se kam" = at least
    check("H2 '10 hazaar se kam nahi' read as a ceiling is caught", cc("goa mein villa, 10 hazaar se kam nahi", { set: { place: "goa", propertyType: "villa", price: { max: 10000 } } }), "budget_direction");
    check("H2 …read as a floor passes", cc("goa mein villa, 10 hazaar se kam nahi", { set: { place: "goa", propertyType: "villa", price: { min: 10000 } } }), null);
    check("H2 'kam se kam 5000' read as a ceiling is caught", cc("goa villa kam se kam 5000", { set: { place: "goa", propertyType: "villa", price: { max: 5000 } } }), "budget_direction");
    check("H2 …read as a floor passes", cc("goa villa kam se kam 5000", { set: { place: "goa", propertyType: "villa", price: { min: 5000 } } }), null);
    check("H2 '9 hazaar se kam' is still a ceiling", cc("goa villa 9 hazaar se kam", { set: { place: "goa", propertyType: "villa", price: { min: 9000 } } }), "budget_direction");
    // H3 / M4: direction words are whole words
    check("H3 'sunder' does not contain 'under'", cc("goa mein koi sunder villa 10k se zyada", { set: { place: "goa", propertyType: "villa", price: { max: 10000 } } }), "budget_direction");
    check("M4 'overlooking' does not contain 'over'", cc("villa overlooking lake under 9k", { set: { propertyType: "villa", price: { max: 9000 }, unsupported: ["overlooking lake"] } }), null);
    check("M4 'take' does not contain 'tak'", cc("villa that can take 8 people, at least 5000", { set: { propertyType: "villa", guests: { min: 8 }, price: { min: 5000 } } }), null);
    // H4 / H5 / M4: a length change never overrides a new start day, and never silently keeps old dates
    const dated: SearchState = { place: "goa", checkIn: "2026-12-06", checkOut: "2026-12-09" };
    const lenG = (msg: string, o: Record<string, unknown>) => { const g = applyGuards(msg, P(o), dated, T); return [g.set.checkIn, g.set.checkOut]; };
    check("H4 'make it 4 nights from friday' keeps the model's new start", lenG("make it 4 nights from friday", { set: { checkIn: "2026-12-04", checkOut: "2026-12-08" } }), ["2026-12-04", "2026-12-08"]);
    check("H4 '4 nights starting the 20th instead' keeps the model's new start", lenG("4 nights starting the 20th instead", { set: { checkIn: "2026-12-20", checkOut: "2026-12-24" } }), ["2026-12-20", "2026-12-24"]);
    check("H5 '5 din ke liye karo' read as a bare length asks instead of keeping the old dates", cc("5 din ke liye karo", { nights: 5 }, dated), "dates_length");
    check("M4 'not 3 nights, make it 5 nights' uses the last length", lenG("not 3 nights, make it 5 nights", { set: { checkIn: "2026-12-06", checkOut: "2026-12-09" } }), ["2026-12-06", "2026-12-11"]);
    {
      const msg = "change it from 3 nights to 5 nights";
      const g = applyGuards(msg, P({ nights: 5 }), dated, T);
      check("M4 'from 3 nights to 5 nights' becomes 6 → 11 Dec and passes the checks", [g.set.checkIn, g.set.checkOut, crossCheck(msg, g, T, dated)], ["2026-12-06", "2026-12-11", null]);
    }
    // H6: "exactly" is about one number; a bare budget is a ceiling
    check("H6 'budget 5000' read as exactly 5000 becomes a ceiling", normaliseExact("villa in goa, budget 5000", P({ set: { price: { min: 5000, max: 5000 } } })).set.price, { max: 5000 });
    // Decided after the third review: an exact cue anywhere keeps an exact count. Over-restricting
    // ("just looking …") only hides stays; tying the cue to its number missed "exactly three".
    check("H6 'just looking for a 3 bedroom villa' keeps the model's exact reading (the safe side)", normaliseExact("just looking for a 3 bedroom villa in goa", P({ set: { bedrooms: { min: 3, max: 3 } } })).set.bedrooms, { min: 3, max: 3 });
    check("R3-H1 'exactly three bedrooms' (a word) stays exact", normaliseExact("exactly three bedrooms in goa", P({ set: { bedrooms: { min: 3, max: 3 } } })).set.bedrooms, { min: 3, max: 3 });
    check("R3-H1 '4BHK only' stays exact", normaliseExact("4BHK only", P({ set: { bedrooms: { min: 4, max: 4 } } })).set.bedrooms, { min: 4, max: 4 });
    check("R3-H1 'सिर्फ 3 बेडरूम' stays exact", normaliseExact("सिर्फ 3 बेडरूम", P({ set: { bedrooms: { min: 3, max: 3 } } })).set.bedrooms, { min: 3, max: 3 });
    check("R3-M1 'budget sirf 5000' read as exactly 5000 is a ceiling", normaliseExact("budget sirf 5000", P({ set: { price: { min: 5000, max: 5000 } } })).set.price, { max: 5000 });
    check("H6 'exactly 3 bedrooms' stays exact", normaliseExact("villa with exactly 3 bedrooms", P({ set: { bedrooms: { min: 3, max: 3 } } })).set.bedrooms, { min: 3, max: 3 });
    check("H6 '3 bedrooms only' stays exact", normaliseExact("3 bedrooms only", P({ set: { bedrooms: { min: 3, max: 3 } } })).set.bedrooms, { min: 3, max: 3 });
    // M1: Devanagari vowel signs belong to the word
    check("M1 'कीमत' (price) does not contain 'मत' (don't)", hasNegation("गोवा में विला, कीमत 8000 तक"), false);
    check("M1 'एकांत' (secluded) is not the number one", numbersIn("एकांत जगह चाहिए").optional, []);
    // M2: an unverified token never reads or writes the browser's plain guest thread
    const g1 = guestIdForUnverifiedToken("g_11111111-2222-3333-4444-555555555555", "expired.token.one");
    check("M2 the derived id is a valid, distinct guest key", [stateKey(null, g1) !== null, g1 !== "g_11111111-2222-3333-4444-555555555555", g1 !== guestIdForUnverifiedToken("g_11111111-2222-3333-4444-555555555555", "expired.token.two")], [true, true, true]);
    // M3: a stay missing from a capped dated search is not "unavailable"
    let page = 0;
    const capped = await inquire(
      { intent: "listing_question", reset: false, set: {}, unset: [], remove: [], soft: [], unsupported: [], priceBasis: "night", target: { ordinals: [1], names: [] }, ask: ["availability"] },
      { place: "x", shownIds: ["Z1"], checkIn: "2026-12-06", checkOut: "2026-12-09" },
      {
        baseUrl: "https://api.example/api/v1",
        fetch: (async (url: string | URL) => {
          if (!new URL(String(url)).searchParams.get("from")) return Response.json({ data: [{ _id: "Z1", title: "Target Villa" }], pagination: { totalCount: 1 }, search: { mode: "place" } });
          page++;
          return Response.json({ data: Array.from({ length: 50 }, (_, i) => ({ _id: `P${page}-${i}`, title: "Other" })), pagination: { totalCount: 300 }, search: { mode: "place" } });
        }) as typeof fetch,
      },
      new AbortController().signal
    );
    check("M3 capped dated search → 'unable to verify', never 'unavailable'", capped.kind === "answer" && capped.text, "Target Villa: unable to verify availability right now.");

    // Benchmark findings on the dev set (2026-11-26, new prompt): field placement and explicit phrases
    const v = validateProposal({ intent: "search", set: { nights: 4 }, unset: ["checkIn", "checkOut"] });
    check("a nested 'nights' is read, and unset checkIn/checkOut mean the dates", v && typeof v !== "string" && [v.nights, v.unset], [4, ["dates"]]);
    const noIntent = validateProposal({ remove: ["wifi"] });
    check("a reading with search fields but no intent is a search", noIntent && typeof noIntent !== "string" && [noIntent.intent, noIntent.remove], ["search", ["wifi"]]);
    check("…an empty object is still unusable", validateProposal({}), null);
    {
      const msg = "make it 4 nights";
      const prev: SearchState = { place: "lucknow", placeType: "room", checkIn: "2026-11-26", checkOut: "2026-11-29" };
      const g = applyGuards(msg, P({ set: { nights: 4 }, unset: ["checkIn", "checkOut"] }), prev, T);
      const s = applyDelta(prev, g);
      check("'make it 4 nights' with that placement ends as 26 → 30 Nov", [s.checkIn, s.checkOut, s.nights, crossCheck(msg, g, T, prev)], ["2026-11-26", "2026-11-30", undefined, null]);
    }
    check("'jaipur ke paas' is the place Jaipur", applyGuards("jaipur ke paas farmhouse", P({ set: { place: "jaipur ke paas", propertyType: "farmhouse" } }), {}, T).set.place, "jaipur");
    check("R3-M6 an English prefix is never cut from a place ('close to nature homestay')", applyGuards("close to nature homestay", P({ set: { place: "close to nature homestay" } }), {}, T).set.place, "close to nature homestay");
    check("'teen raat' the model left out is kept as 3 nights", applyGuards("dharamshala mein teen raat rukna hai", P({ set: { place: "dharamshala" } }), {}, T).nights, 3);
    check("…not when dates exist", applyGuards("teen raat aur", P({ set: {} }), { checkIn: "2026-12-06", checkOut: "2026-12-09" }, T).nights, undefined);
    check("…not on a question about a policy", applyGuards("can i cancel a 3 night booking", { ...P({ set: {} }), intent: "policy" }, {}, T).nights, undefined);
    {
      const g = applyGuards("do log hain, pahad ka view ho to accha", P({ set: { guests: { min: 2 } }, unsupported: ["pahad ka view"] }), {}, T);
      check("'pahad ka view ho to accha' is a nice-to-have, not a must-have", [g.unsupported, g.soft], [[], ["pahad ka view"]]);
    }
    {
      const g = applyGuards("sea view would be nice, private pool is a must", P({ set: { amenitiesAll: ["pool"] }, unsupported: ["sea view"] }), {}, T);
      // (expectation changed 2026-11-27: the private part of a must-have "private pool" the model dropped is now kept, spec C1)
      check("only the item next to 'would be nice' moves (R3-H3); the dropped 'private' of a must-have private pool is kept", [g.unsupported, g.soft], [["private pool"], ["sea view"]]);
    }
    {
      const g = applyGuards("villa in morjim for 10, private pool is a must, also need power backup", P({ set: { amenitiesAll: ["pool"] }, unsupported: ["power backup"] }), {}, T);
      check("'private pool' read as a plain pool: the private part is kept as unsupported", g.unsupported, ["power backup", "private pool"]);
      const g2 = applyGuards("private pool chahiye", P({ set: { amenitiesAll: ["pool"] }, unsupported: ["private pool"] }), {}, T);
      check("…not added twice", g2.unsupported, ["private pool"]);
      check("…not when that clause is negated ('private pool nahi chahiye')", applyGuards("villa with pool, private pool nahi chahiye", P({ set: { amenitiesAll: ["pool"] } }), {}, T).unsupported, []);
      const g3 = applyGuards("villa with a pool, private parking", P({ set: { amenitiesAll: ["pool", "free-parking"] } }), {}, T);
      check("…'private parking' is not a private pool", g3.unsupported, []);
      const g4 = applyGuards("mandrem me beach ke paas 2 logo ke liye kuch dikhao", P({ set: { place: "mandrem", guests: { min: 2 }, amenitiesAll: ["beach"] } }), {}, T);
      check("'beach ke paas' is a distance (unsupported), not the beach amenity", [g4.set.amenitiesAll, g4.unsupported], [undefined, ["near the beach"]]);
      const g5 = applyGuards("villa near the beach with a pool", P({ set: { amenitiesAll: ["beach", "pool"] }, unsupported: ["near the beach"] }), {}, T);
      check("…other amenities stay; the model's own label is not doubled", [g5.set.amenitiesAll, g5.unsupported], [["pool"], ["near the beach"]]);
      const g6 = applyGuards("beachfront villa near the beach", P({ set: { amenitiesAll: ["beach"] } }), {}, T);
      check("…'beachfront' keeps the amenity", g6.set.amenitiesAll, ["beach"]);
      const g7 = applyGuards("self check in ho to best, raat ko late pahunchenge", P({ set: { selfCheckIn: true } }), {}, T);
      check("'self check in ho to best' is a nice-to-have", [g7.set.selfCheckIn, g7.soft], [undefined, ["self check-in"]]);
      const g8 = applyGuards("self check in chahiye, warna nahi chalega, ho to best", P({ set: { selfCheckIn: true } }), {}, T);
      check("…not with 'warna nahi chalega'", g8.set.selfCheckIn, true);
      const g9 = applyGuards("pool is a must, bbq if possible", P({ set: { amenitiesAll: ["pool", "bbq"] } }), {}, T);
      check("'bbq if possible' moves; the pool stays a must-have", [g9.set.amenitiesAll, g9.soft], [["pool"], ["bbq"]]);
      check("…and is not listed twice", applyGuards("pool is a must, bbq if possible", P({ set: { amenitiesAll: ["pool", "bbq"] }, soft: ["bbq if possible"] }), {}, T).soft, ["bbq if possible"]);
      check("'2 adults 2 kids and an infant': the article is the infant count", cc("villa in morjim under 10k for 2 adults 2 kids and an infant", { set: { place: "morjim", propertyType: "villa", price: { max: 10000 }, guests: { min: 4 } }, infants: 1 }), null);
      check("…an infant count never typed is still caught", cc("villa in morjim under 10k for 2 adults 2 kids", { set: { place: "morjim", propertyType: "villa", price: { max: 10000 }, guests: { min: 4 } }, infants: 1 }), "numbers");
    }
    // Third review (2026-11-26)
    check("R3-H2 'not more than 8000' read as a ceiling passes", cc("villa in goa not more than 8000", { set: { place: "goa", propertyType: "villa", price: { max: 8000 } } }), null);
    check("R3-H2 …read as a floor is caught", cc("villa in goa not more than 8000", { set: { place: "goa", propertyType: "villa", price: { min: 8000 } } }), "budget_direction");
    check("R3-H2 'not less than 5000' read as a floor passes", cc("villa in goa not less than 5000", { set: { place: "goa", propertyType: "villa", price: { min: 5000 } } }), null);
    check("R3-H2 …read as a ceiling is caught", cc("villa in goa not less than 5000", { set: { place: "goa", propertyType: "villa", price: { max: 5000 } } }), "budget_direction");
    {
      const msg = "forget the dates, 4 nights is enough";
      const g = applyGuards(msg, P({ nights: 4, unset: ["dates"] }), dated, T);
      const s = applyDelta(dated, g);
      check("R3-H4 'forget the dates, 4 nights' drops the dates (never rebuilt)", [s.checkIn, s.checkOut, s.nights, crossCheck(msg, g, T, dated)], [undefined, undefined, 4, null]);
    }
    {
      const g = applyGuards("need a balcony, a sea-facing balcony would be nice", P({ unsupported: ["balcony", "sea-facing balcony"] }), {}, T);
      check("R3-H5 'balcony' named twice stays a must-have; only 'sea-facing balcony' moves", [g.unsupported, g.soft], [["balcony"], ["sea-facing balcony"]]);
      check("R3-H5 'garden is a must, rooftop garden ho to accha' keeps the garden", applyGuards("garden is a must, rooftop garden ho to accha", P({ unsupported: ["garden"] }), {}, T).unsupported, ["garden"]);
      check("R3-L1 '… ho to accha, warna nahi chalega' is a must-have", applyGuards("caretaker ho to accha, warna nahi chalega", P({ unsupported: ["caretaker"] }), {}, T).unsupported, ["caretaker"]);
    }
    const vp = (o: Record<string, unknown>) => { const r = validateProposal(o); return r && typeof r !== "string" ? r : r; };
    check("R3-H6 'unset amenitiesNone' never wipes the required amenities", (vp({ intent: "search", unset: ["amenitiesNone"] }) as Proposal).unset, []);
    check("R3-H7 intent and target nested in set are read", (() => { const r = vp({ set: { intent: "listing_question", target: { ordinals: [2] }, ask: ["amenities"] } }) as Proposal; return [r.intent, r.target.ordinals, r.ask]; })(), ["listing_question", [2], ["amenities"]]);
    check("R3-H7 no intent but a target is not treated as a search", vp({ target: { ordinals: [2] }, set: { amenitiesAll: ["pool"] } }), null);
    check("R3-H7 a nested reset is read", (vp({ intent: "search", set: { reset: true, place: "jaipur" } }) as Proposal).reset, true);
    check("R3-H8 a list in both places is joined", (vp({ intent: "search", unsupported: ["jacuzzi"], set: { unsupported: ["sea view"] } }) as Proposal).unsupported, ["jacuzzi", "sea view"]);
    check("R3-H8 …and amenities too", (vp({ intent: "search", amenitiesAll: ["pool"], set: { amenitiesAll: ["wifi"] } }) as Proposal).set.amenitiesAll, ["pool", "wifi"]);
    check("R3-H8 two different values for one field are unusable", vp({ intent: "search", place: "goa", set: { place: "jaipur" } }), null);
    check("R3-M2 'zyada se zyada 8000' read as a floor is caught", cc("goa villa zyada se zyada 8000", { set: { place: "goa", propertyType: "villa", price: { min: 8000 } } }), "budget_direction");
    check("R3-M2 '5000 kam se kam' read as a floor passes", cc("goa villa 5000 kam se kam", { set: { place: "goa", propertyType: "villa", price: { min: 5000 } } }), null);
    check("R3-M2 …read as a ceiling is caught", cc("goa villa 5000 kam se kam", { set: { place: "goa", propertyType: "villa", price: { max: 5000 } } }), "budget_direction");
    check("R3-M2 '5000 and above' read as a ceiling is caught", cc("goa villa 5000 and above", { set: { place: "goa", propertyType: "villa", price: { max: 5000 } } }), "budget_direction");
    check("R3-M2 '5000+' read as a ceiling is caught", cc("goa villa 5000+", { set: { place: "goa", propertyType: "villa", price: { max: 5000 } } }), "budget_direction");
    check("R3-M2 '10k max' read as a floor is caught", cc("goa villa 10k max", { set: { place: "goa", propertyType: "villa", price: { min: 10000 } } }), "budget_direction");
    check("R3-M3 'over the weekend, under 10k' is not a floor", cc("goa villa over the weekend, under 10k", { set: { place: "goa", propertyType: "villa", price: { max: 10000 } }, soft: ["weekend"] }), null);
    check("R3-M3 '10 min from baga, under 8000' is not a floor", cc("villa 10 min from baga, under 8000", { set: { propertyType: "villa", price: { max: 8000 } }, unsupported: ["10 min from baga"] }), null);
    check("R3-M3 '8000 se zyada na ho' is a ceiling", cc("goa villa 8000 se zyada na ho", { set: { place: "goa", propertyType: "villa", price: { max: 8000 } } }), null);
    {
      const msg = "make it 10 dec to 12 dec";
      const r = vp({ intent: "search", set: { checkIn: "2026-12-10", checkOut: "2026-12-12" }, unset: ["checkIn", "checkOut"] }) as Proposal;
      check("R3-M3 new dates with an echoed unset are a replacement, not a removal", [r.unset, crossCheck(msg, applyGuards(msg, r, dated, T), T, dated)], [[], null]);
    }
    check("R3-M4 'change it to 5 din' with dates set asks", cc("change it to 5 din", { nights: 5, unset: ["checkIn", "checkOut"] }, dated), "dates_length");
    check("R3-M5 '2 bade bedroom' (big bedrooms) is not a breakdown", cc("4 log hain, 2 bade bedroom chahiye", { set: { guests: { min: 4 } } }), "numbers");
    check("R3 '4 nights please' (a new length + unset nights) is a replacement", cc("4 nights please", { nights: 4, unset: ["nights"] }, { place: "goa", nights: 3 }), null);
    {
      const msg = "dates are flexible, around 4 nights";
      const g = applyGuards(msg, P({ nights: 4, unset: ["dates"] }), dated, T);
      check("R3 'dates are flexible, around 4 nights' drops the dates without a question", [crossCheck(msg, g, T, dated), applyDelta(dated, g).checkIn, applyDelta(dated, g).nights], [null, undefined, 4]);
    }
    check("R3 an unset of the dates alone still needs a cue", cc("goa please", { unset: ["dates"] }, dated), "negation");
    check("R3-L2 'two to four nights' adds no length", applyGuards("goa two to four nights", P({ set: { place: "goa" } }), {}, T).nights, undefined);
    check("R3-L2 'can't do 3 nights' adds no length", applyGuards("goa, can't do 3 nights", P({ set: { place: "goa" } }), {}, T).nights, undefined);
    {
      const msg = "goa 30 dec to 2 jan";
      const g = applyGuards(msg, P({ reset: true, set: { place: "goa", checkIn: "2026-12-30", checkOut: "2027-01-02" } }), {}, T);
      check("'reset' on a first message is a no-op, not a refused removal", [g.reset, crossCheck(msg, g, T, {})], [false, null]);
      const g2 = applyGuards("show goa", P({ reset: true, set: { place: "goa" } }), { place: "jaipur", guests: { min: 4 } }, T);
      check("…with a search in progress an unasked reset is applied as a change (place replaced, the rest kept)", [g2.reset, crossCheck("show goa", g2, T, { place: "jaipur", guests: { min: 4 } })], [false, null]);
      const prevA: SearchState = { place: "arpora", guests: { min: 3 }, propertyType: "apartment", amenitiesAll: ["pool"] };
      for (const m of ["nahi, goa mein dikhao", "नहीं, गोवा में दिखाओ", "no, in goa"]) {
        const g3 = applyGuards(m, P({ reset: true, set: { place: "goa" } }), prevA, T);
        check(`'${m}' after a search: a correction, not a new search`, g3.reset, false);
      }
      for (const m of ["start over, villa in goa", "naya search karo, goa mein villa", "new search: villa in goa", "फिर से शुरू करो, गोवा में विला"]) {
        const g4 = applyGuards(m, P({ reset: true, set: { place: "goa", propertyType: "villa" } }), prevA, T);
        check(`'${m}': the customer asked for a new search`, g4.reset, true);
      }
    }
    check("a must-have with no soft cue stays a must-have", applyGuards("sea view chahiye", P({ unsupported: ["sea view"] }), {}, T).unsupported, ["sea view"]);
    check("'no private pool needed' adds nothing", applyGuards("pool ok but no private pool needed", P({ set: { amenitiesAll: ["pool"] } }), {}, T).unsupported, []);
  });

  // Needless refusals found by the matched Qwen / GPT-OSS benchmark on the dev Hindi and Hinglish set (2026-11-26).
  await group("followups-hinglish", async () => {
    const P = (o: Record<string, unknown>): Proposal => {
      const p = validateProposal({ intent: "search", ...o });
      if (!p || typeof p === "string") throw new Error("bad proposal");
      return p;
    };
    const T = "2026-11-25";
    const cc = (msg: string, o: Record<string, unknown>, prev: SearchState = {}) => crossCheck(msg, applyGuards(msg, P(o), prev, T), T, prev);
    check("'10k se zyada mehenga nahi chahiye' is a ceiling", cc("10k se zyada mehenga nahi chahiye, assagao mein teen bedroom ka villa", { set: { place: "assagao", propertyType: "villa", bedrooms: { min: 3 }, price: { max: 10000 } } }), null);
    check("…read as a floor it is caught", cc("10k se zyada mehenga nahi chahiye, assagao mein teen bedroom ka villa", { set: { place: "assagao", propertyType: "villa", bedrooms: { min: 3 }, price: { min: 10000 } } }), "budget_direction");
    check("'budget 25k tak, isse zyada nahi' is a bound, not a negation", cc("budget 25k tak, isse zyada nahi", { set: { price: { max: 25000 } } }, { place: "north goa" }), null);
    check("'aur budget 15 hazaar se zyada nahi' is a ceiling", cc("aur budget 15 hazaar se zyada nahi", { set: { price: { max: 15000 } } }, { place: "assagao", guests: { min: 5 } }), null);
    check("'3 din 2 raat' accounts for the 3", cc("paanch hazaar se kam mein cavelossim me flat milega kya? 3 din 2 raat ka plan hai", { set: { place: "cavelossim", propertyType: "apartment", price: { max: 5000 } }, nights: 2 }), null);
    check("'paisa koi issue nahi' is not a negation", cc("paisa koi issue nahi, bas AC aur wifi dono chahiye", { set: { amenitiesAll: ["air-conditioning", "wifi"] } }, { place: "anjuna" }), null);
    check("…and it may drop a budget that was set", cc("paisa koi issue nahi", { unset: ["price"] }, { place: "anjuna", price: { max: 5000 } }), null);
    check("unsetting a budget that was never set is not a suspicious removal", cc("budget ka abhi pata nahi, bas kitchen hona chahiye", { set: { amenitiesAll: ["kitchen"] }, unset: ["price"] }, { place: "goa", guests: { min: 4 } }), null);
    check("…unsetting one that IS set without a cue keeps it (candidate 3: dropped, not asked)", applyGuards("goa please", P({ unset: ["price"] }), { place: "goa", price: { max: 5000 } }, T).unset, []);
    check("'इस वीकेंड' is a time word", hasDateCue("इस वीकेंड उज्जैन में रुकना है, चार लोग हैं"), true);
    {
      const g = applyGuards("इस वीकेंड उज्जैन में रुकना है, चार लोग हैं", P({ set: { place: "उज्जैन", guests: { min: 4 }, checkIn: "2026-11-27", checkOut: "2026-11-29" } }), {}, T);
      check("'इस वीकेंड' read as Fri–Sun → Saturday to Monday", [g.set.checkIn, g.set.checkOut], ["2026-11-28", "2026-11-30"]);
    }
    const noPlace = async () => false;
    for (const m of ["isse sasta kuch hai?", "इससे सस्ता कुछ दिखाओ", "aur sasta", "something cheaper", "anything less expensive?"]) {
      const q = await quickRead(m, noPlace);
      check(`'${m}' notes the wish 'cheaper' without a model and changes nothing`, q && [q.soft, q.set], [["cheaper"], {}]);
    }
    check("'something expensive' is not 'cheaper'", await quickRead("something expensive", noPlace), null);
    check("'sasta villa in goa' carries requirements: left to the full reader", (await quickRead("sasta villa in goa", noPlace))?.soft ?? null, null);
  });

  // Candidate 3 (2026-11-27): recurring causes found in the retired heldout3 / heldout4 sets, checked here with
  // DIFFERENT phrasings than the cases they came from (golden/README is the rule each one follows).
  await group("candidate-3", async () => {
    const P = (o: Record<string, unknown>): Proposal => {
      const p = validateProposal({ intent: "search", ...o });
      if (!p || typeof p === "string") throw new Error("bad proposal");
      return p;
    };
    const T = "2026-11-25";
    const run = (msg: string, o: Record<string, unknown>, prev: SearchState = {}) => {
      const p = stripRestated(normaliseExact(msg, applyGuards(msg, P(o), prev, T)), prev);
      return { p, problem: crossCheck(msg, p, T, prev), next: applyDelta(prev, p) };
    };

    // ── the group's size is arithmetic ──
    const hc = (m: string) => headcount(m)?.total ?? null;
    check("'two adults and one 8 year old girl' = 3", hc("two adults and one 8 year old girl"), 3);
    check("'we are 3 couples' = 6", hc("we are 3 couples"), 6);
    check("'mere saath meri biwi aur do bacche' = 4 (me, wife, two kids)", hc("mere saath meri biwi aur do bacche"), 4);
    check("'just me, travelling solo' = 1", hc("just me, travelling solo"), 1);
    check("'4 grown-ups and a toddler' = 4 guests and an infant", [hc("4 grown-ups and a toddler"), headcount("4 grown-ups and a toddler")?.infants], [4, 1]);
    check("'one couple plus a 3 year old' = 3", hc("one couple plus a 3 year old"), 3);
    check("'दो बड़े और दो बच्चे' = 4", hc("दो बड़े और दो बच्चे"), 4);
    check("'family with kids' has no count", hc("family with kids"), null);
    check("a stated total is left to the total ('hum chaar log hain, do bade do bacche')", hc("hum chaar log hain, do bade do bacche"), null);
    check("'show me villas for 6' names no group parts", hc("show me villas for 6"), null);
    {
      const r = run("2 couples, villa in candolim", { set: { place: "candolim", propertyType: "villa", guests: { min: 2 } } });
      check("'2 couples' read as 2 guests is corrected to 4 and accepted", [r.problem, r.next.guests], [null, { min: 4 }]);
      const k = run("for me, my husband and our 3 kids, flat in baga", { set: { place: "baga", propertyType: "apartment", guests: { min: 5 } } });
      check("'me, my husband and our 3 kids' = 5 is accepted (no 'numbers' question)", [k.problem, k.next.guests], [null, { min: 5 }]);
      const a = run("meri behen bhi aa rahi hai", { set: { guests: { min: 5 } } }, { place: "goa", guests: { min: 4 } });
      check("'meri behen bhi aa rahi hai' after 4 guests = 5 (people being added are not a new group)", [a.problem, a.next.guests], [null, { min: 5 }]);
      const s = run("sirf main hoon, akela", { set: { guests: { min: 1 } } }, { place: "manali", placeType: "room" });
      check("'sirf main hoon, akela' = 1 guest, accepted", [s.problem, s.next.guests], [null, { min: 1 }]);
    }

    // ── a follow-up that replaces one value keeps everything else ──
    const prevV: SearchState = { place: "goa", propertyType: "villa", guests: { min: 6 }, amenitiesAll: ["pool"], price: { max: 15000 } };
    for (const [m, o, want] of [
      ["nahi yaar, calangute mein dekho", { set: { place: "calangute" }, unset: ["propertyType", "price"] }, { ...prevV, place: "calangute" }],
      ["actually make it baga instead", { set: { place: "baga" }, unset: ["guests", "amenities"] }, { ...prevV, place: "baga" }],
      ["theek hai, 8 log ho jayenge", { set: { guests: { min: 8 } }, unset: ["amenities"] }, { ...prevV, guests: { min: 8 } }],
      ["budget 20k kar do", { set: { price: { max: 20000 } }, remove: ["pool"] }, { ...prevV, price: { max: 20000 } }],
      ["नहीं, अंजुना में", { reset: true, set: { place: "अंजुना" }, unset: ["guests"] }, { ...prevV, place: "अंजुना" }],
      ["ok and from 10 to 12 jan", { set: { checkIn: "2027-01-10", checkOut: "2027-01-12" }, unset: ["price"] }, { ...prevV, checkIn: "2027-01-10", checkOut: "2027-01-12" }],
    ] as [string, Record<string, unknown>, SearchState][]) {
      const r = run(m, o, prevV);
      check(`'${m}': only the named value changes, every other requirement carries forward`, [r.problem, r.next], [null, want]);
    }
    {
      const r = run("koi bhi type chalega", { unset: ["propertyType"] }, prevV);
      check("'koi bhi type chalega' still removes the type (a removal word)", r.next.propertyType, undefined);
      const w = run("pool ki zarurat nahi ab", { remove: ["pool"] }, prevV);
      check("'pool ki zarurat nahi ab' after a pool was asked for removes it (not an exclusion)", [w.next.amenitiesAll, w.next.amenitiesNone], [undefined, undefined]);
    }

    // ── negations: their own clause, a bound is not one, a never-asked-for "X nahi chahiye" excludes ──
    check("'6000 se upar nahi, wifi chahiye' negates no amenity", negatedAmenities("6000 se upar nahi, wifi chahiye"), []);
    check("'kitchen nahi chahiye, lekin AC zaroori' negates only the kitchen", negatedAmenities("kitchen nahi chahiye, lekin AC zaroori").map((n) => n.key), ["kitchen"]);
    check("'no TV, parking needed' negates only the TV", negatedAmenities("no TV, parking needed").map((n) => n.key), ["tv"]);
    {
      const r = run("TV nahi chahiye", { remove: ["tv"] }, { place: "goa", guests: { min: 2 } });
      check("'TV nahi chahiye' when no TV was asked for is an exclusion", [r.problem, r.next.amenitiesNone], [null, ["tv"]]);
      const b = run("budget 4000 se zyada nahi aur free parking honi chahiye", { set: { price: { max: 4000 }, amenitiesAll: ["free-parking"] } }, { place: "ooty" });
      check("'4000 se zyada nahi aur free parking' is a ceiling plus parking, no question", [b.problem, b.next.price, b.next.amenitiesAll], [null, { max: 4000 }, ["free-parking"]]);
    }

    // ── dates are arithmetic ──
    {
      const a = run("parso se 3 raat", { set: { checkIn: "2026-11-27" }, nights: 3 }, { place: "goa" });
      check("'parso se 3 raat' = 27 → 30 Nov", [a.problem, a.next.checkIn, a.next.checkOut, a.next.nights], [null, "2026-11-27", "2026-11-30", undefined]);
      const b = run("aaj raat ke liye ek kamra chahiye pune mein", { set: { place: "pune", placeType: "room", checkIn: "2026-11-25" } });
      check("'aaj raat ke liye' = one night", [b.problem, b.next.checkIn, b.next.checkOut], [null, "2026-11-25", "2026-11-26"]);
      const c = run("from 20 dec for 4 nights", { set: { checkIn: "2026-12-20" } }, { place: "coorg" });
      check("'from 20 dec for 4 nights' = 20 → 24 Dec", [c.problem, c.next.checkOut], [null, "2026-12-24"]);
      const d = run("is weekend pondicherry mein 2 log", { set: { place: "pondicherry", guests: { min: 2 } }, nights: 2 });
      check("'is weekend' read only as 2 nights = Sat 28 → Mon 30 Nov", [d.problem, d.next.checkIn, d.next.checkOut], [null, "2026-11-28", "2026-11-30"]);
      const e = run("30 dec to 3 jan in kasol", { set: { place: "kasol", checkIn: "2026-12-30", checkOut: "2027-03-01" } });
      check("'30 dec to 3 jan' read as 1 March is repaired to 3 Jan", [e.problem, e.next.checkOut], [null, "2027-01-03"]);
      check("written dates in order ('5 se 8 jan', 'dec 24')", [writtenDates("5 se 8 jan"), writtenDates("arriving dec 24")], [[{ d: 5, m: 1 }, { d: 8, m: 1 }], [{ d: 24, m: 12 }]]);
      const g = run("need a villa on 5 jan for 4", { set: { propertyType: "villa", guests: { min: 4 } }, unsupported: ["5 jan"] });
      check("a lone date is a question, even when the model filed it as unsupported", g.problem, "dates_half");
      const h = run("aaj kal kahan ghoomne jaun? goa mein villa dikhao", { set: { place: "goa", propertyType: "villa" } });
      check("'aaj kal' (nowadays) sets no dates", [h.next.checkIn, h.next.checkOut], [undefined, undefined]);
    }

    // ── type, place type, soft and insisted wishes ──
    {
      check("'lonavala mein 4 bedroom ka ghar' has no property type", run("lonavala mein 4 bedroom ka ghar", { set: { place: "lonavala", bedrooms: { min: 4 }, propertyType: "house" } }).next.propertyType, undefined);
      check("'independent house in pune' stays a house", run("independent house in pune", { set: { place: "pune", propertyType: "house" } }).next.propertyType, "house");
      check("'pura ghar chahiye shimla mein' = the whole place", run("pura ghar chahiye shimla mein", { set: { place: "shimla" } }).next.placeType, "entire");
      const s1 = run("villa in vagator, ideally with a firepit", { set: { place: "vagator", propertyType: "villa", amenitiesAll: ["firepit"] } });
      check("'ideally with a firepit' is a wish, not a requirement", [s1.next.amenitiesAll, s1.next.soft], [undefined, ["firepit"]]);
      const s2 = run("flat in pune, preferably having a kitchen", { set: { place: "pune", propertyType: "apartment", amenitiesAll: ["kitchen"] } });
      check("'preferably having a kitchen' is a wish", s2.next.amenitiesAll, undefined);
      const s3 = run("cottage in kasauli, it has to be peaceful", { set: { place: "kasauli" }, soft: ["peaceful"] });
      check("'it has to be peaceful' is a must-have no field can check", [s3.next.unsupported, s3.next.soft], [["peaceful"], undefined]);
      const s4 = run("quiet place in coorg would be nice", { set: { place: "coorg" }, soft: ["quiet"] });
      check("a plain vibe stays soft", s4.next.soft, ["quiet"]);
    }

    // ── private pool, amenity words filed as unsupported, an invented price ──
    {
      const a = run("apna pool chahiye, lonavala villa", { set: { place: "lonavala", propertyType: "villa" }, unsupported: ["private pool"] });
      check("'apna pool' = pool AND unsupported private pool", [a.next.amenitiesAll, a.next.unsupported], [["pool"], ["private pool"]]);
      const b = run("goa villa with lake side", { set: { place: "goa", propertyType: "villa" }, unsupported: ["lake side"] });
      check("'lake side' filed as unsupported becomes the lake amenity", [b.next.amenitiesAll, b.next.unsupported], [["lake"], undefined]);
      const c = run("stay in gokarna with beach access", { set: { place: "gokarna" }, unsupported: ["beach access"] });
      check("'beach access' becomes the beach amenity", c.next.amenitiesAll, ["beach"]);
      const d = run("villa with a lake view in udaipur", { set: { place: "udaipur", propertyType: "villa" }, unsupported: ["lake view"] });
      check("'lake view' stays unsupported (a view is not an amenity)", [d.next.amenitiesAll, d.next.unsupported], [undefined, ["lake view"]]);
      const e = run("kam budget wala room manali mein", { set: { place: "manali", placeType: "room", price: { max: 3000 } } });
      check("'kam budget wala room' with no amount: the invented price goes, 'cheaper' is noted", [e.problem, e.next.price, e.next.soft], [null, undefined, ["cheaper"]]);
      const g = run("budget ki tension nahi", { set: { price: { max: 20000 } } }, { place: "goa", price: { max: 8000 } });
      check("'budget ki tension nahi' read as a new ceiling: the budget is removed instead", [g.problem, g.next.price], [null, undefined]);
    }

    // ── found by the live dev run of the c3 phrasings (2026-11-27 13:17) ──
    {
      const a = run("wanna book a cottage in kasol for 4 on 5 jan", { set: { place: "kasol", guests: { min: 4 }, checkIn: "2027-01-05", checkOut: "2027-01-06" } });
      check("one written date and a check-out nobody typed is a question", a.problem, "dates_half");
      const b = run("villa in goa for 4, 24 dec to 27th", { set: { place: "goa", propertyType: "villa", guests: { min: 4 }, checkIn: "2026-12-24", checkOut: "2026-12-27" } });
      check("…a typed check-out day ('to 27th') is not invented", b.problem, null);
      const c = run("12 jan se", { set: { checkIn: "2027-01-12" } }, { place: "auli", guests: { min: 4 }, nights: 3 });
      check("…nor one that follows from nights given earlier", [c.problem, c.next.checkOut], [null, "2027-01-15"]);
      const d = run("teen bachche bhi saath aayenge", { set: { guests: { min: 4 } } }, { place: "ooty", guests: { min: 4 } });
      check("'teen bachche bhi saath aayenge' after 4 guests = 7, even when the model kept 4", [d.problem, d.next.guests], [null, { min: 7 }]);
      const e = run("2 more friends are joining us", { set: { guests: { min: 5 } } }, { place: "goa", guests: { min: 3 } });
      check("'2 more friends are joining us' after 3 guests = 5", [e.problem, e.next.guests], [null, { min: 5 }]);
      check("'a kitchen and no tv' negates only the TV", negatedAmenities("a kitchen and no tv").map((n) => n.key), ["tv"]);
      check("'TV nahi, wifi chahiye' negates only the TV", negatedAmenities("TV nahi, wifi chahiye").map((n) => n.key), ["tv"]);
      check("'pool, not needed' negates the pool across the comma", negatedAmenities("pool, not needed").map((n) => n.key), ["pool"]);
      const f = run("4 log, kitchen chahiye aur no AC please", { set: { guests: { min: 4 }, amenitiesAll: ["kitchen"], amenitiesNone: ["air-conditioning"] } }, { place: "munnar" });
      check("'kitchen chahiye aur no AC' = kitchen and no AC, no question", [f.problem, f.next.amenitiesAll, f.next.amenitiesNone], [null, ["kitchen"], ["air-conditioning"]]);
    }

    // ── a list written as one string is still a list ──
    check("soft written as one string is split, not lost", validateProposal({ intent: "search", soft: "quiet, garden" }) && (validateProposal({ intent: "search", soft: "quiet, garden" }) as Proposal).soft, ["quiet", "garden"]);

    // ── fast paths ──
    check("'thanks a lot bhai' is thanks", fastPath("thanks a lot bhai", false)?.kind, "thanks");
    check("'shukriya ji' is thanks", fastPath("shukriya ji", false)?.kind, "thanks");
    check("'new search kar do' is a reset", fastPath("new search kar do", false)?.kind, "reset");
    check("'thank you, also show villas' is not only thanks", fastPath("thank you, also show villas", false), null);
  });

  await group("change-list", async () => {
    // The model's explicit change list: each change names its field, what it does, and the customer's words.
    const V = (o: Record<string, unknown>) => validateProposal({ intent: "search", ...o });
    const ch = (op: string, field: string, value: unknown, said: string) => ({ do: op, field, value, said });
    {
      const p = V({ changes: [ch("set", "place", "north goa", "North Goa"), ch("set", "guests", { min: 6 }, "6 ppl"), ch("set", "price", { max: 15000 }, "under 15k")] });
      check("set changes become requirements", p && typeof p === "object" && [p.set.place, p.set.guests, p.set.price, p.changes?.length], ["north goa", { min: 6 }, { max: 15000 }, 3]);
      const r = V({ changes: [ch("remove", "price", undefined, "forget the budget"), ch("remove", "amenitiesAll", "pool", "pool nahi chahiye"), ch("remove", "dates", undefined, "dates flexible hain"), ch("remove", "soft", "quiet", "quiet zaroori nahi")] });
      check("removals: a field is unset, a list item is removed", r && typeof r === "object" && [r.unset, r.remove], [["price", "dates"], ["pool", "quiet"]]);
      const a = V({ changes: [ch("add", "amenitiesAll", "pool", "pool"), ch("add", "amenitiesAll", "wifi", "wifi"), ch("add", "unsupported", "sea view", "sea view"), ch("add", "soft", "quiet", "quiet ho to accha")] });
      check("additions go to their lists", a && typeof a === "object" && [a.set.amenitiesAll, a.unsupported, a.soft], [["pool", "wifi"], ["sea view"], ["quiet"]]);
      const b = V({ changes: [{ do: "set", field: "price", value: { max: 5000 }, said: "5000 per person", basis: "person" }] });
      check("a per-person amount keeps its basis (asked about, never converted)", b && typeof b === "object" && b.priceBasis, "person");
      check("an unknown field refuses the whole reading", V({ changes: [ch("set", "seaView", true, "sea view")] }), null);
      check("an unknown action refuses the whole reading", V({ changes: [ch("replace", "place", "goa", "goa")] }), null);
      const n = V({ newSearch: true, changes: [ch("set", "place", "manali", "manali")] });
      check("newSearch is a reset", n && typeof n === "object" && n.reset, true);
      const d = V({ changes: [ch("set", "dates", { checkIn: "2026-12-18", checkOut: "2026-12-21" }, "18 to 21 december"), ch("set", "nights", 3, "3 nights")] });
      check("dates and nights", d && typeof d === "object" && [d.set.checkIn, d.set.checkOut, d.nights], ["2026-12-18", "2026-12-21", 3]);
    }

    {
      // the compact form: values in "set", removals as a list with the customer's words
      const h = validateProposal({ intent: "search", set: { place: "north goa", guests: { min: 6 } }, unsupported: ["sea view"], remove: [{ field: "price", said: "budget ki tension nahi" }, { field: "amenitiesAll", value: "pool", said: "pool nahi chahiye" }] });
      check("compact form: set values kept, removals become changes with their words", h && typeof h === "object" && [h.set.place, h.set.guests, h.unsupported, h.unset, h.remove, h.changes?.map((c) => c.said)],
        ["north goa", { min: 6 }, ["sea view"], ["price"], ["pool"], ["budget ki tension nahi", "pool nahi chahiye"]]);
      const s = validateProposal({ intent: "search", set: { place: "goa" }, remove: ["pool"] });
      check("an old-style removal list (no words) is still read, and judged by the earlier rules", s && typeof s === "object" && [s.remove, s.changes], [["pool"], undefined]);
      const prevG: SearchState = { place: "goa", price: { max: 10000 } };
      const j = judgeRemovals("actually north goa", validateProposal({ intent: "search", set: { place: "north goa" }, remove: [{ field: "price", said: "actually" }] }) as Proposal, prevG);
      check("compact form: an unnamed removal beside a new value is dropped", [j.p.unset, j.doubt], [[], null]);
      const w = ownWords("गोवा में विला", validateProposal({ intent: "search", changes: [ch("set", "place", "goa", "गोवा में")] }) as Proposal);
      check("own words drop the postposition ('गोवा में' → 'गोवा')", w.set.place, "गोवा");
      const lk = ownWords("उदयपुर में झील किनारे विला चाहिए 10 लोगों के लिए", validateProposal({ intent: "search", changes: [ch("add", "unsupported", "lake side", "उदयपुर में झील किनारे विला चाहिए 10 लोगों के लिए")] }) as Proposal);
      check("a whole sentence quoted is not used as a value", lk.unsupported, ["lake side"]);
    }

    // ── a removal is applied only when the customer asked for it, in their own words ──
    const prev: SearchState = { place: "goa", guests: { min: 6 }, price: { max: 10000 }, propertyType: "villa", amenitiesAll: ["pool", "air-conditioning"], checkIn: "2026-12-18", checkOut: "2026-12-21" };
    const judge = (msg: string, changes: Record<string, unknown>[]) => {
      const p = V({ changes });
      if (!p || typeof p !== "object") throw new Error("bad");
      const j = judgeRemovals(msg, p, prev);
      return { unset: j.p.unset, remove: j.p.remove, doubt: j.doubt?.field ?? null };
    };
    const kept = { unset: [], remove: [], doubt: null };
    check("'actually North Goa' with a removal of the budget the model added: only the place changes",
      judge("actually North Goa", [ch("set", "place", "north goa", "North Goa"), ch("remove", "price", undefined, "actually North Goa")]), kept);
    check("'nahi, north goa mein dikhao': the 'nahi' is about the place, the budget stays",
      judge("nahi, north goa mein dikhao", [ch("set", "place", "north goa", "north goa mein dikhao"), ch("remove", "price", undefined, "nahi")]), kept);
    check("'नहीं, उत्तर गोवा में दिखाओ': the same in Hindi",
      judge("नहीं, उत्तर गोवा में दिखाओ", [ch("set", "place", "उत्तर गोवा", "उत्तर गोवा"), ch("remove", "amenitiesAll", "pool", "नहीं")]), kept);
    check("a removal whose words are not in the message is dropped ('make it 3 bedrooms')",
      judge("make it 3 bedrooms", [ch("set", "bedrooms", { min: 3 }, "3 bedrooms"), ch("remove", "price", undefined, "forget the budget")]), kept);
    check("'budget ki tension mat lo, bas pool chahiye': the budget goes",
      judge("budget ki tension mat lo, bas pool chahiye", [ch("remove", "price", undefined, "budget ki tension mat lo")]), { unset: ["price"], remove: [], doubt: null });
    check("'forget the price limit' removes the budget",
      judge("forget the price limit", [ch("remove", "price", undefined, "forget the price limit")]), { unset: ["price"], remove: [], doubt: null });
    check("'बजट की कोई सीमा नहीं' removes the budget",
      judge("बजट की कोई सीमा नहीं", [ch("remove", "price", undefined, "बजट की कोई सीमा नहीं")]), { unset: ["price"], remove: [], doubt: null });
    check("'10k wala limit hata do' names the budget by its value",
      judge("10k wala limit hata do", [ch("remove", "price", undefined, "10k wala limit hata do")]), { unset: ["price"], remove: [], doubt: null });
    check("'AC hatao' removes the AC",
      judge("AC hatao", [ch("remove", "amenitiesAll", "air-conditioning", "AC hatao")]), { unset: [], remove: ["air-conditioning"], doubt: null });
    check("'पूल ज़रूरी नहीं है' removes the pool",
      judge("पूल ज़रूरी नहीं है", [ch("remove", "amenitiesAll", "pool", "पूल ज़रूरी नहीं है")]), { unset: [], remove: ["pool"], doubt: null });
    check("'koi bhi type chalega' removes the property type",
      judge("koi bhi type chalega", [ch("remove", "propertyType", undefined, "koi bhi type chalega")]), { unset: ["propertyType"], remove: [], doubt: null });
    check("'villa hona zaroori nahi' names the type by its value",
      judge("villa hona zaroori nahi", [ch("remove", "propertyType", undefined, "villa hona zaroori nahi")]), { unset: ["propertyType"], remove: [], doubt: null });
    check("'dates abhi fix nahi hain' removes the dates",
      judge("dates abhi fix nahi hain", [ch("remove", "dates", undefined, "dates abhi fix nahi hain")]), { unset: ["dates"], remove: [], doubt: null });
    check("'Goa wala hatao' names the place by its value",
      judge("Goa wala hatao", [ch("remove", "place", undefined, "Goa wala hatao")]), { unset: ["place"], remove: [], doubt: null });
    check("'that's not needed anymore' alone names nothing: one question, nothing removed yet",
      judge("that's not needed anymore", [ch("remove", "price", undefined, "that's not needed anymore")]), { unset: ["price"], remove: [], doubt: "price" });
    check("'budget hata do aur 8 log' removes the budget and sets the guests",
      judge("budget hata do aur 8 log", [ch("remove", "price", undefined, "budget hata do"), ch("set", "guests", { min: 8 }, "8 log")]), { unset: ["price"], remove: [], doubt: null });
    check("a quote with one typo still counts as the customer's words", saidIn("pool not neded", "pool not needed actually"), true);
    {
      // values are the customer's words, even when the model translated or respelled them
      const p = V({ changes: [ch("set", "place", "udaypur", "उदयपुर"), ch("add", "unsupported", "near the sea", "समुद्र के पास")] });
      const o = p && typeof p === "object" ? ownWords("उदयपुर में समुद्र के पास होटल", p) : null;
      check("a respelled place and a translated must-have are taken from the quoted words", o && [o.set.place, o.unsupported], ["उदयपुर", ["समुद्र के पास"]]);
      const q = V({ changes: [ch("set", "place", "north goa", "in north goa please")] });
      check("a place already in the message is kept as the model wrote it", q && typeof q === "object" && ownWords("villa in north goa please", q).set.place, "north goa");
      const m = V({ changes: [ch("set", "place", "gokarna", "gokarna")], unsupported: "beachfront" });
      check("a field written beside the change list is kept, not dropped", m && typeof m === "object" && [m.set.place, m.unsupported], ["gokarna", ["beachfront"]]);
      check("'scratch everything, totally different thing now' is a new search", applyGuards("scratch everything, totally different thing now. hotel in varanasi", V({ newSearch: true, changes: [ch("set", "place", "varanasi", "varanasi")] }) as Proposal, { place: "kasol" }, "2026-11-25").reset, true);
      {
        const prevK: SearchState = { place: "kasol", guests: { min: 3 }, petsAllowed: true };
        const msg = "hotel in varanasi for my parents, 2 ppl";
        const p = V({ changes: [ch("set", "place", "varanasi", "varanasi"), ch("set", "guests", { min: 2 }, "2 ppl")] }) as Proposal;
        check("'for my parents, 2 ppl' (the group named twice) is 2 guests, no numbers question", crossCheck(msg, stripRestated(normaliseExact(msg, applyGuards(msg, p, prevK, "2026-11-25")), prevK), "2026-11-25", prevK), null);
        const msg2 = "villa for my parents and 3 bedrooms";
        const p2 = V({ changes: [ch("set", "guests", { min: 2 }, "my parents")] }) as Proposal;
        check("…but a different typed number still has to be used ('my parents and 3 bedrooms' read as guests only)", crossCheck(msg2, stripRestated(normaliseExact(msg2, applyGuards(msg2, p2, {}, "2026-11-25")), {}), "2026-11-25", {}), "numbers");
      }
      check("'nahi, varanasi mein' is not a new search", applyGuards("nahi, varanasi mein", V({ newSearch: true, changes: [ch("set", "place", "varanasi", "varanasi")] }) as Proposal, { place: "kasol" }, "2026-11-25").reset, false);
    }
    check("a quote mostly not in the message does not", saidIn("forget the whole budget please", "make it 3 bedrooms"), false);

    // ── one focused question; the search stays as it is until the answer ──
    const saved = (name: string) => JSON.parse(readFileSync(`eval/contract/${name}.json`, "utf8")) as { status: number; body: { data: Listing[] } };
    const script: Record<string, unknown> = {
      "villas in goa for 6 under 10k": { intent: "search", changes: [ch("set", "place", "goa", "goa"), ch("set", "propertyType", "villa", "villas"), ch("set", "guests", { min: 6 }, "for 6"), ch("set", "price", { max: 10000 }, "under 10k")] },
      "that's not needed": { intent: "search", changes: [ch("remove", "price", undefined, "that's not needed")] },
      "actually north goa": { intent: "search", changes: [ch("set", "place", "north goa", "north goa"), ch("remove", "price", undefined, "actually")] },
      "make it 8 people": { intent: "search", changes: [ch("set", "guests", { min: 8 }, "8 people")] },
    };
    const store = memoryStore();
    const deps: PipelineDeps = {
      now: () => new Date("2026-11-25T06:00:00Z"),
      store,
      catalog: { baseUrl: "https://api.example/api/v1", fetch: (async () => Response.json(saved("place-goa").body, { status: 200 })) as typeof fetch },
      llm: async (_s, user) => ({ ok: true, json: script[JSON.parse(user).message as string], provider: "groq", tokensIn: 0, tokensOut: 0, attempts: 1, ms: 0 }),
    };
    const key = "g:g_44444444-dddd";
    const say = (message: string) => handleTurn({ message, key }, deps, new AbortController().signal);
    const st = () => { const { shownIds: _s, ...rest } = store.docs.get(key)!.state; return rest; };
    await say("villas in goa for 6 under 10k");
    const before = st();
    let r = await say("that's not needed");
    check("an unnamed removal: one focused question showing the resulting search", [r.outcome, r.text.startsWith("Just to check: should I remove up to ₹10,000/night?"), r.text.includes("goa · 6 guests · villa")], ["clarify", true, true]);
    check("…and nothing is applied before the answer", st(), before);
    r = await say("no");
    check("'no' keeps the search exactly as it was", [r.outcome, st()], ["declined", before]);
    await say("that's not needed");
    r = await say("yes");
    check("'yes' applies exactly the change that was asked about", [SEARCH.has(r.outcome), st().price, st().place, st().guests], [true, undefined, "goa", { min: 6 }]);
    await say("villas in goa for 6 under 10k");
    await say("that's not needed");
    r = await say("make it 8 people");
    check("another instruction instead of an answer: the question lapses, the new change applies, the rest stays", [st().guests, st().price], [{ min: 8 }, { max: 10000 }]);
    r = await say("actually north goa");
    check("a replacement keeps every other requirement (the model's extra removal is dropped)", [SEARCH.has(r.outcome), st().place, st().price, st().guests, st().propertyType], [true, "north goa", { max: 10000 }, { min: 8 }, "villa"]);
  });

  await group("candidate-5", async () => {
    // readings seen in the candidate-4 live runs (dev-fresh, reg-h3, reg-h4)
    const P = (o: Record<string, unknown>) => validateProposal({ intent: "search", ...o }) as Proposal;
    check("a basis written inside the price is kept (change list)", P({ changes: [{ do: "set", field: "price", value: { max: 40000, basis: "stay" }, said: "budget 40k for the whole week" }] }).priceBasis, "stay");
    check("…and in the compact form", P({ set: { price: { max: 2000, basis: "person" } } }).priceBasis, "person");
    check("a budget basis is asked about, never applied per night", crossCheck("budget 40k for the whole week", P({ set: { price: { max: 40000, basis: "stay" } } }), "2026-11-25", { place: "goa" }), "budget_basis");
    check("{flexible: true} is the value flexible", P({ changes: [{ do: "set", field: "cancellation", value: { flexible: true }, said: "flexible cancellation only" }] }).set.cancellation, "flexible");
    const kids = P({ set: { place: "coorg", guests: { min: 3 } }, nights: 3, infants: 1 });
    check("'2 adults 1 baccha': a child is not an infant", normaliseExact("coorg mein homestay, 3 raat, 2 adults 1 baccha", kids).infants, undefined);
    check("…and the numbers then add up", crossCheck("coorg mein homestay, 3 raat, 2 adults 1 baccha", normaliseExact("coorg mein homestay, 3 raat, 2 adults 1 baccha", kids), "2026-11-25"), null);
    check("an infant word keeps the infant", normaliseExact("4 adults aur 1 infant", P({ set: { guests: { min: 4 } }, infants: 1 })).infants, 1);
    check("…a baby's age too", normaliseExact("2 adults and our 6 month old baby", P({ set: { guests: { min: 2 } }, infants: 1 })).infants, 1);
    for (const m of ["नमस्ते", "नमस्कार!", "namaste"]) check(`'${m}' is a greeting`, fastPath(m, false), { kind: "greeting" });
    const g = applyGuards("lonavala mein farmhouse chahiye 15 log hain, 31 dec se 2 jan", P({ set: { place: "lonavala", checkIn: "2025-12-31", checkOut: "2026-02-01" } }), {}, "2026-11-25");
    check("last year written for '31 dec se 2 jan': the coming 31 Dec to 2 Jan", [g.set.checkIn, g.set.checkOut], ["2026-12-31", "2027-01-02"]);
    const pvt = applyGuards("villa in north goa, pvt pool, wifi", P({ set: { place: "north goa", amenitiesAll: ["wifi"] }, unsupported: ["private pool"] }), {}, "2026-11-25");
    check("'pvt pool' is a pool AND an unverifiable private", [pvt.set.amenitiesAll?.includes("pool"), pvt.unsupported.some((u) => /private/.test(u))], [true, true]);
    const two = await inquire(
      { ...P({}), intent: "listing_question", ask: [] },
      { place: "x", shownIds: ["A1", "B2"] },
      { baseUrl: "https://api.example/api/v1", fetch: (async () => Response.json({ data: [{ _id: "A1", title: "First Stay", amenities: [] }, { _id: "B2", title: "Second Stay", amenities: ["free-parking"] }], pagination: { totalCount: 2 }, search: { mode: "place" } })) as typeof fetch },
      new AbortController().signal,
      "दूसरे वाले में पार्किंग है क्या?"
    );
    check("'दूसरे वाले' is the second stay shown, when the reading left it out", two.kind === "answer" && two.text.includes("Second Stay") && !two.text.includes("First Stay"), true);
    const ex = (m: string, o: Record<string, unknown>) => normaliseExact(m, P(o)).set;
    check("'exactly 2 bedrooms' read as at least 2: both ends", ex("munnar, exactly 2 bedrooms and up to 2 bathrooms", { set: { place: "munnar", bedrooms: { min: 2 }, bathrooms: { max: 2 } } }).bedrooms, { min: 2, max: 2 });
    check("'2 bedrooms' stays a minimum", ex("munnar, 2 bedrooms", { set: { bedrooms: { min: 2 } } }).bedrooms, { min: 2 });
    check("'5 to 8 january' is dates, not 5 to 8 guests", ex("homestay in alleppey 5 to 8 january", { set: { place: "alleppey", checkIn: "2027-01-05", checkOut: "2027-01-08", guests: { min: 5, max: 8 } } }).guests, undefined);
    check("…a group typed beside the dates is kept ('5 to 8 jan for 5')", ex("5 to 8 jan for 5", { set: { checkIn: "2027-01-05", checkOut: "2027-01-08", guests: { min: 5 } } }).guests, { min: 5 });
    check("…and so is one named with a people word", ex("5 to 8 jan, 5 log", { set: { checkIn: "2027-01-05", checkOut: "2027-01-08", guests: { min: 5 } } }).guests, { min: 5 });
    check("{pool: true, wifi: true} as an amenity list", P({ set: { amenitiesAll: { pool: true, wifi: true } } }).set.amenitiesAll, ["pool", "wifi"]);
    // readings seen in the Haiku 5.5 live runs
    check("'between 5 and 8 thousand' is 5000 and 8000", numbersIn("too much actually. between 5 and 8 thousand").required, [5000, 8000]);
    check("…'for 2 and 15k' stays two numbers", numbersIn("villa for 2 and 15k max").required, [2, 15000]);
    check("…'8-10k' unchanged", numbersIn("8-10k per night").required, [8000, 10000]);
    check("'can't do without it' insists, it does not negate", hasNegation("not sure about budget yet but wifi is a must, can't do without it"), false);
    check("…'can't do with a pool' still negates", hasNegation("can't do with a shared pool"), true);
    check("'scrap that, lets begin again' starts a new search when the model reads it so", applyGuards("scrap that, lets begin again", P({ reset: true }), { place: "anjuna", guests: { min: 5 } }, "2026-11-25").reset, true);
    const basis = (m: string) => normaliseExact(m, P({ set: { price: { max: 60000 } }, priceBasis: "stay" })).priceBasis;
    check("'budget 60 hazaar tak' is per night, whatever basis the model guessed", basis("jaipur ke paas farmhouse bees logon ke liye, budget 60 hazaar tak"), "night");
    for (const m of ["poore trip ka budget 40 hazaar hai", "budget 40k for the whole week", "बजट प्रति व्यक्ति 2000 रुपये", "60k total"]) check(`'${m}' keeps its non-nightly basis`, basis(m), "stay");
    for (const m of ["सब छोड़ो, गोवा में 4 लोगों के लिए विला", "सब छोड़ो, गोवा में विला", "sab chhodo, goa mein villa"]) {
      check(`'${m.slice(0, 12)}…' starts a new search when the model reads it so`, applyGuards(m, P({ reset: true, set: { place: "goa" } }), { place: "manali", unsupported: ["private pool"] }, "2026-11-25").reset, true);
    }
    const ns = validateProposal({ intent: "search", newSearch: true }) as Proposal;
    check("'newSearch' with no change list is a reset ('sab reset karo')", [ns.reset, ns.changes], [true, []]);
    const view = (m: string, o: Record<string, unknown>) => { const g = applyGuards(m, P(o), {}, "2026-11-25"); return [g.set.amenitiesAll, g.unsupported, g.soft]; };
    check("'lake view wala room': a view is not the lakeside amenity; it is a must-have no field can check", view("udaipur mein lake view wala room chahiye couple ke liye", { set: { place: "udaipur", amenitiesAll: ["lake"] }, soft: ["lake view"] }), [undefined, ["lake view"], []]);
    check("…a lakeside stay asked for as well keeps the amenity", view("lakeside villa with a lake view", { set: { amenitiesAll: ["lake"] }, unsupported: ["lake view"] }), [["lake"], ["lake view"], []]);
    check("…'a pool view would be nice' stays a nice-to-have, and the pool is not required", view("villa in goa, a pool view would be nice", { set: { place: "goa", amenitiesAll: ["pool"] } }), [undefined, [], ["pool view"]]);
    check("…'sea view' (no amenity) is kept as the model put it", view("sea view villa", { unsupported: ["sea view"] }), [undefined, ["sea view"], []]);
  });

  await group("filters-mode", async () => {
    // The pilot: the guest sets the search with buttons (ops, no model); a typed message is at most a draft.
    const saved = (name: string) => JSON.parse(readFileSync(`eval/contract/${name}.json`, "utf8")) as { status: number; body: { data: Listing[] } };
    const ch = (op: string, field: string, value: unknown, said: string) => ({ do: op, field, value, said });
    const world = (script: Record<string, unknown> = {}) => {
      const store = memoryStore();
      const calls = { llm: 0, urls: [] as string[] };
      const deps: PipelineDeps = {
        now: () => new Date("2026-11-25T06:00:00Z"),
        store,
        catalog: { baseUrl: "https://api.example/api/v1", fetch: (async (url: string | URL) => { calls.urls.push(String(url)); return Response.json(saved("place-goa").body, { status: 200 }); }) as typeof fetch },
        llm: async (_s, user) => {
          calls.llm++;
          const json = script[JSON.parse(user).message as string];
          if (json === "FAIL") return { ok: false, why: "failed", attempts: 2, errors: ["x"] };
          if (json === "QUOTA") return { ok: false, why: "unavailable", attempts: 2, errors: ["429"] };
          return { ok: true, json, provider: "test", tokensIn: 0, tokensOut: 0, attempts: 1, ms: 0 };
        },
      };
      const key = "g:g_55555555-eeee";
      const turn = (message: string, extra: Partial<Parameters<typeof handleTurn>[0]> = {}) =>
        handleTurn({ message, key, readMode: "off", dated: false, ...extra }, deps, new AbortController().signal);
      const st = () => { const { shownIds: _s, ...rest } = store.docs.get(key)?.state ?? {}; return rest; };
      return { turn, st, calls, store, key };
    };

    {
      const w = world();
      let r = await w.turn("Set filters", { op: { set: { place: "goa", guests: { min: 6 }, price: { max: 10000 }, amenitiesAll: ["pool"], propertyType: "villa" } } });
      check("filters set by buttons: searched, no model call", [SEARCH.has(r.outcome), w.calls.llm, w.st()], [true, 0, { place: "goa", guests: { min: 6 }, price: { max: 10000 }, amenitiesAll: ["pool"], propertyType: "villa" }]);
      check("…the reply carries the chips and the state the editor starts from", [r.chips?.map((c) => c.label).length, r.state.place], [5, "goa"]);
      r = await w.turn("Change place", { op: { unset: ["place"], set: { place: "north goa" } } });
      check("changing the place changes only the place (guests, budget, type, amenities kept)", w.st(), { place: "north goa", guests: { min: 6 }, price: { max: 10000 }, amenitiesAll: ["pool"], propertyType: "villa" });
      await w.turn("Budget", { op: { set: { price: { min: 5000 } } } });
      await w.turn("Budget", { op: { unset: ["price"], set: { price: { max: 8000 } } } });
      check("an edited budget replaces the old one exactly (unset + set)", w.st().price, { max: 8000 });
      await w.turn("Remove pool", { op: { remove: ["pool"] } });
      check("removing a chip removes only that requirement", [w.st().amenitiesAll, w.st().guests], [undefined, { min: 6 }]);
      r = await w.turn("villa in goa for 8 under 5k");
      check("AI drafting off: a typed message changes nothing and needs no model", [r.outcome, w.calls.llm, w.st().guests, r.chips?.length], ["use_filters", 0, { min: 6 }, 4]);
      r = await w.turn("x", { op: { set: { seaView: true } } });
      check("an op with an unknown field is refused whole; the search is unchanged", [r.outcome, w.st().place], ["not_processed", "north goa"]);
      r = await w.turn("Start over", { op: { reset: true } });
      check("reset by button clears every filter", [w.st(), r.outcome], [{}, "need_details"]);
      r = await w.turn("Dates", { op: { set: { place: "goa", checkIn: "2026-12-20", checkOut: "2026-12-23" } as never } });
      check("dated search off: dates are not kept and not sent to the search", [w.st().checkIn, w.calls.urls.some((u) => /[?&](from|to|checkIn|checkOut|startDate)=/.test(u))], [undefined, false]);
      check("…no availability is claimed, and the reply stays short (no repeated price / dates notes)", [/Available for your dates/.test(r.text), r.cards.every((c) => c.availability === undefined), /Prices are per night|Open a stay to pick/.test(r.text)], [false, true, false]);
    }

    {
      const w = world({
        "actually north goa, budget doesn't matter": { intent: "search", changes: [ch("set", "place", "north goa", "north goa"), ch("remove", "price", undefined, "budget doesn't matter")] },
        "goa villa 24 to 27 dec under 40k for the whole trip": { intent: "search", set: { place: "goa", propertyType: "villa", checkIn: "2026-12-24", checkOut: "2026-12-27", price: { max: 40000, basis: "stay" } } },
        "villa with a private pool": { intent: "search", changes: [ch("set", "propertyType", "villa", "villa"), ch("add", "amenitiesAll", "pool", "private pool"), ch("add", "unsupported", "private pool", "private pool")] },
        "fail please": "FAIL",
        "quota please": "QUOTA",
      });
      await w.turn("Set", { op: { set: { place: "goa", guests: { min: 6 }, price: { max: 10000 }, amenitiesAll: ["pool"] } } });
      const before = w.st();
      let r = await w.turn("actually north goa, budget doesn't matter", { readMode: "draft" });
      check("draft: shown, nothing applied", [r.outcome, w.st()], ["draft", before]);
      check("draft: the replacement and the removal are explicit lines", r.draft?.lines.map((l) => [l.kind, l.label]), [["change", "Change goa to north goa"], ["remove", "Remove up to ₹10,000/night"]]);
      check("draft: shows what the guest asked", r.draft?.said, "actually north goa, budget doesn't matter");
      // the guest confirms both lines: their ops, merged, are applied as buttons
      const merged = { unset: r.draft!.lines.flatMap((l) => l.op.unset ?? []), set: Object.assign({}, ...r.draft!.lines.map((l) => l.op.set ?? {})) };
      const calls = w.calls.llm;
      await w.turn("Apply", { op: merged });
      check("confirmed draft: place replaced, budget removed, guests and pool kept, no model call", [w.st(), w.calls.llm], [{ place: "north goa", guests: { min: 6 }, amenitiesAll: ["pool"] }, calls]);

      r = await w.turn("goa villa 24 to 27 dec under 40k for the whole trip", { readMode: "draft" });
      check("draft: a whole-trip budget is not turned into a nightly one; dates are not used; both are said", [r.draft?.lines.some((l) => /₹/.test(l.label)), r.draft?.lines.some((l) => /Dec/.test(l.label)), r.draft?.notes.length], [false, false, 2]);
      await w.turn("Budget", { op: { set: { price: { max: 15000 } } } });
      r = await w.turn("goa villa 24 to 27 dec under 40k for the whole trip", { readMode: "draft" });
      check("…and with a nightly budget already set, the draft does not offer to remove it", r.draft?.lines.some((l) => l.kind === "remove"), false);
      r = await w.turn("show me villas in north goa under 5k", { readMode: "draft", fastOnly: true });
      check("a quick-answer button never reaches the model, whatever its text", [r.outcome, w.calls.llm], ["use_filters", 3]);
      r = await w.turn("x", { op: {} });
      check("an op that changes nothing never reaches the model", [r.outcome, w.calls.llm], ["not_processed", 3]);
      r = await w.turn("x", { op: { set: {} } });
      check("…nor does an empty set", [r.outcome, w.calls.llm], ["not_processed", 3]);
      r = await w.turn("villa with a private pool", { readMode: "draft" });
      check("draft: 'private pool' is a pool plus an unverifiable line, with a note", [r.draft?.lines.map((l) => l.kind), r.draft?.notes.some((n) => /private pool/.test(n))], [["add", "unverified"], true]);

      const kept = w.st();
      r = await w.turn("fail please", { readMode: "draft" });
      check("both models fail: filters unchanged, said plainly, the buttons still have the chips", [r.outcome, r.text, w.st(), (r.chips ?? []).length > 0], ["not_processed", FIXED.draft_busy, kept, true]);
      r = await w.turn("quota please", { readMode: "draft" });
      check("both models out of quota: the same, as 'busy'", [r.outcome, r.text, w.st()], ["busy", FIXED.draft_busy, kept]);
      r = await w.turn("Remove pool", { op: { remove: ["pool"] } });
      check("…and the guest completes a search with the buttons right after", [SEARCH.has(r.outcome), w.st().amenitiesAll], [true, undefined]);
      // an unverifiable must-have: the consent question, answered by its quick button (no model)
      const llmBefore = w.calls.llm;
      r = await w.turn("Add private pool", { op: { set: { amenitiesAll: ["pool"] }, unsupported: ["private pool"] } });
      check("'private pool' is never a match: the guest is asked first, with quick answers", [r.outcome, r.cards.length], ["possible_ask", 0]);
      r = await w.turn("Yes, show them", { fastOnly: true });
      check("…'Yes, show them' shows them, each labelled not verified, without a model", [r.outcome, r.cards.every((c) => c.group === "possible" && /not verified: private pool/.test(c.note ?? "")), w.calls.llm], ["possible_shown", true, llmBefore]);
    }

    {
      // Claude through the official SDK, with the same injected fetch the other providers use
      const A: Provider = { kind: "anthropic", model: "claude-haiku-5-5", key: "test-key" };
      const Q: Provider = { kind: "groq", model: "qwen-b", key: "k2" };
      const msg = (text: string, stop = "end_turn") => new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 2300, output_tokens: 40 } }), { status: 200, headers: { "content-type": "application/json" } });
      const run = async (handler: () => Response) => {
        const seen: string[] = [];
        const bodies: Record<string, unknown>[] = [];
        const cfg: LlmConfig = {
          chain: [A, Q], health: newHealth(), reserve: async () => true,
          fetch: (async (url: string | URL, init?: RequestInit) => {
            const u = String(url instanceof Request ? url.url : url);
            seen.push(u.includes("anthropic") ? "anthropic" : "groq");
            if (u.includes("anthropic")) { bodies.push(JSON.parse(String(init?.body ?? "{}"))); return handler(); }
            return Response.json({ choices: [{ message: { content: '{"intent":"greeting"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
          }) as typeof fetch,
        };
        return { out: await proposeJson("sys", "usr", cfg, new AbortController().signal), seen, bodies };
      };
      let x = await run(() => msg('{"intent":"search","set":{"place":"goa"}}'));
      check("anthropic: answers through the SDK with the injected fetch", [x.out.ok && x.out.provider, x.out.ok && x.out.json, x.seen], ["anthropic:claude-haiku-5-5", { intent: "search", set: { place: "goa" } }, ["anthropic"]]);
      const sys = (x.bodies[0]?.system as { text?: string; cache_control?: { type?: string } }[] | undefined)?.[0];
      check("anthropic: the request names the model, the cached system prompt and no thinking", [x.bodies[0]?.model, sys?.text, sys?.cache_control?.type, (x.bodies[0]?.thinking as { type?: string })?.type], ["claude-haiku-5-5", "sys", "ephemeral", "disabled"]);
      x = await run(() => new Response(JSON.stringify({ id: "msg_2", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: '{"intent":"greeting"}' }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 300, output_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } }));
      check("anthropic: a cache hit is reported (and counted in the input tokens)", x.out.ok && [x.out.cacheRead, x.out.cacheWrite, x.out.tokensIn], [2000, 0, 2300]);
      x = await run(() => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "20" } }));
      check("anthropic 429: the next chain entry answers in the same request, no SDK retry", [x.out.ok && x.out.provider, x.seen], ["groq:qwen-b", ["anthropic", "groq"]]);
      x = await run(() => msg("", "refusal"));
      check("anthropic refusal: a failed attempt, the next entry answers", [x.out.ok && x.out.provider, x.seen], ["groq:qwen-b", ["anthropic", "groq"]]);
      check("anthropic: parsed from ANTHROPIC_API_KEY only when set", [parseChain("anthropic:claude-haiku-5-5", { anthropic: "k" }).length, parseChain("anthropic:claude-haiku-5-5", {}).length], [1, 0]);
    }
  });

  await group("draft-doubts", async () => {
    // A part the checks doubt never appears as a draft line (it would be one tap from being applied); the note says why.
    const saved = JSON.parse(readFileSync("eval/contract/place-goa.json", "utf8")) as { status: number; body: unknown };
    const make = (script: Record<string, unknown>) => {
      const store = memoryStore();
      const deps: PipelineDeps = {
        now: () => new Date("2026-11-25T06:00:00Z"),
        store,
        catalog: { baseUrl: "https://api.example/api/v1", fetch: (async () => Response.json(saved.body, { status: 200 })) as typeof fetch },
        llm: async (_s, user) => ({ ok: true, json: script[JSON.parse(user).message as string], provider: "test", tokensIn: 0, tokensOut: 0, attempts: 1, ms: 0 }),
      };
      const key = "g:g_77777777-dddd";
      const turn = (message: string, extra: Partial<Parameters<typeof handleTurn>[0]> = {}) =>
        handleTurn({ message, key, readMode: "draft", dated: false, ...extra }, deps, new AbortController().signal);
      return { turn, st: () => store.docs.get(key)?.state ?? {} };
    };
    const priceLines = (r: TurnResult) => (r.draft?.lines ?? []).filter((l) => (l.op.set as Record<string, unknown> | undefined)?.price !== undefined);
    {
      const w = make({ "4000 se zyada nahi": { intent: "search", changes: [{ do: "set", field: "price", value: { min: 4000 }, basis: "night", said: "4000 se zyada nahi" }] } });
      await w.turn("Set filters", { op: { set: { place: "goa" } } });
      const r = await w.turn("4000 se zyada nahi");
      check("an inverted budget (\"not more than\" read as a floor) is left out of the draft", [r.outcome, priceLines(r).length, (r.draft?.notes ?? []).some((n) => /most you want to pay/.test(n)), w.st().price], ["draft", 0, true, undefined]);
    }
    {
      const w = make({ "4000 se zyada nahi": { intent: "search", changes: [{ do: "set", field: "price", value: { max: 4000 }, basis: "night", said: "4000 se zyada nahi" }] } });
      await w.turn("Set filters", { op: { set: { place: "goa" } } });
      const r = await w.turn("4000 se zyada nahi");
      check("…read the right way round, the budget is a draft line", [priceLines(r).length, (priceLines(r)[0]?.op.set as { price?: unknown })?.price], [1, { max: 4000 }]);
    }
    const guard = (message: string, set: Record<string, unknown>) => {
      const p = validateProposal({ intent: "search", set });
      if (!p || typeof p !== "object") throw new Error("proposal");
      const g = applyGuards(message, p, {}, "2026-11-25");
      return [g.set.amenitiesAll ?? null, g.set.amenitiesAny ?? null, g.unsupported];
    };
    check("heater read as AC: the AC goes, the heater stays as unsupported", guard("kitchen aur heater dono chahiye", { amenitiesAll: ["kitchen", "air-conditioning"] }), [["kitchen"], null, ["heater"]]);
    check("…a room heater, in the customer's words", guard("must have a room heater and free parking", { amenitiesAll: ["air-conditioning", "free-parking"] }), [["free-parking"], null, ["room heater"]]);
    check("…AC named as well: kept", guard("AC aur heater dono chahiye", { amenitiesAll: ["air-conditioning"] }), [["air-conditioning"], null, []]);
    check("…no heater wanted: the AC goes, nothing is added", guard("heater nahi chahiye", { amenitiesAll: ["air-conditioning"] }), [null, null, []]);
  });

  await group("draft-apply-equivalence", async () => {
    // Property: applying every line of a draft (as the Apply button does: merged ops, model-free path) gives exactly
    // the search the reading itself gives. The draft card never shows one change and applies another.
    let s = 99;
    const r = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const AM = AMENITY_KEYS as readonly string[];
    const range = () => { const a = 1 + Math.floor(r() * 8); return pick([{ min: a }, { max: a + 2 }, { min: a, max: a + 3 }]); };
    const randomState = (): SearchState => {
      const st: Record<string, unknown> = {};
      if (r() < 0.7) st.place = pick(["goa", "north goa", "manali"]);
      if (r() < 0.6) st.guests = { min: 1 + Math.floor(r() * 10) };
      if (r() < 0.5) st.price = pick([{ max: 1000 * (2 + Math.floor(r() * 30)) }, { min: 2000, max: 9000 }, { min: 5000 }]);
      if (r() < 0.3) st.bedrooms = range();
      if (r() < 0.4) st.propertyType = pick(["villa", "apartment", "house"]);
      if (r() < 0.2) st.placeType = pick(["entire", "room"]);
      if (r() < 0.5) st.amenitiesAll = [...new Set([pick(AM), pick(AM)])];
      if (r() < 0.2) st.amenitiesNone = [pick(AM)];
      if (r() < 0.15) st.amenitiesAny = [...new Set([pick(AM), pick(AM), pick(AM)])].slice(0, 2);
      if (r() < 0.2) st.petsAllowed = true;
      if (r() < 0.2) st.cancellation = pick(["flexible", "strict"]);
      if (r() < 0.2) st.unsupported = [pick(["private pool", "sea view"])];
      if (r() < 0.2) st.soft = [pick(["quiet", "romantic"])];
      // the state a real merge produces: an amenity is never both wanted and excluded
      if (Array.isArray(st.amenitiesNone) && Array.isArray(st.amenitiesAll)) st.amenitiesAll = (st.amenitiesAll as string[]).filter((x) => !(st.amenitiesNone as string[]).includes(x));
      if (Array.isArray(st.amenitiesAny) && (st.amenitiesAny as string[]).length < 2) delete st.amenitiesAny;
      if (Array.isArray(st.amenitiesAll) && !(st.amenitiesAll as string[]).length) delete st.amenitiesAll;
      return st as SearchState;
    };
    const randomReading = (prev: SearchState): Proposal => {
      const o: Record<string, unknown> = { intent: "search", set: {} as Record<string, unknown> };
      const set = o.set as Record<string, unknown>;
      if (r() < 0.1) o.reset = true;
      if (r() < 0.3) set.place = pick(["south goa", "calangute", "jaipur"]);
      if (r() < 0.3) set.guests = { min: 1 + Math.floor(r() * 12) };
      if (r() < 0.3) set.price = pick([{ max: 1000 * (3 + Math.floor(r() * 20)) }, { min: 3000 }, { min: 1000, max: 15000 }]);
      if (r() < 0.2) set.bedrooms = range();
      if (r() < 0.2) set.propertyType = pick(["villa", "guesthouse", "hotel"]);
      if (r() < 0.3) set.amenitiesAll = [pick(AM)];
      if (r() < 0.15) set.amenitiesNone = [pick(AM)];
      if (r() < 0.1) set.amenitiesAny = [pick(AM), pick(AM)];
      if (r() < 0.1) set.selfCheckIn = true;
      if (r() < 0.25) {
        const lists = [...(prev.amenitiesAll ?? []), ...(prev.amenitiesNone ?? []), ...(prev.unsupported ?? []), ...(prev.soft ?? [])];
        if (lists.length) o.remove = [pick(lists)];
      }
      if (r() < 0.25) { const fs = (["price", "guests", "propertyType", "placeType", "cancellation", "petsAllowed", "bedrooms", "place"] as const).filter((k) => prev[k] !== undefined); if (fs.length) o.unset = [pick(fs)]; }
      if (r() < 0.1) o.unsupported = [pick(["near the beach", "jacuzzi"])];
      if (r() < 0.1) o.soft = [pick(["cheaper", "peaceful"])];
      const p = validateProposal(o);
      return (p && typeof p === "object" ? p : (validateProposal({ intent: "search", set: { place: "goa" } }) as Proposal));
    };
    const canon = (v: unknown): unknown => (Array.isArray(v) ? [...v].map(canon).sort() : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
    const norm = (st: SearchState) => JSON.stringify(canon(st));
    let cases = 0, lines = 0;
    const failures: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const prev = randomState();
      const p = randomReading(prev);
      const next = applyDelta(prev, p);
      const d = draftOf("x", prev, next, p.reset, [], "2026-11-25");
      lines += d.lines.length;
      const op = (() => {
        const ops = d.lines.map((l) => l.op);
        const out: Record<string, unknown> = {};
        for (const k of ["unset", "remove", "unsupported", "soft"] as const) { const v = ops.flatMap((o) => (o as Record<string, string[]>)[k] ?? []); if (v.length) out[k] = [...new Set(v)]; }
        const set: Record<string, unknown> = {};
        for (const o of ops) for (const [k, v] of Object.entries(o.set ?? {})) set[k] = Array.isArray(v) && Array.isArray(set[k]) ? [...new Set([...(set[k] as unknown[]), ...v])] : v;
        if (Object.keys(set).length) out.set = set;
        if (ops.some((o) => o.reset)) out.reset = true;
        return out;
      })();
      const parsed = validateProposal({ intent: "search", set: (op.set as object) ?? {}, unset: op.unset, remove: op.remove, unsupported: op.unsupported, soft: op.soft, reset: op.reset === true });
      const applied = parsed && typeof parsed === "object" ? applyDelta(prev, parsed) : null;
      cases++;
      if (!applied || norm(applied) !== norm(next)) failures.push(`prev ${norm(prev)}\n  reading ${JSON.stringify({ set: p.set, unset: p.unset, remove: p.remove, reset: p.reset })}\n  draft ${d.lines.map((l) => l.label).join(" | ")}\n  expected ${norm(next)}\n  applied  ${applied ? norm(applied) : "refused"}`);
    }
    if (failures.length) console.log(`  first failures (${failures.length}):\n  ` + failures.slice(0, 3).join("\n  "));
    check(`${cases} random readings (${lines} draft lines): Apply gives exactly the search the draft shows`, failures.length, 0);
  });

  await group("llm", async () => {
    const never = new AbortController().signal;
    const G: Provider = { kind: "gemini", model: "gem-a", key: "k1" };
    const Q: Provider = { kind: "groq", model: "qwen-b", key: "k2" };
    const O: Provider = { kind: "groq", model: "gpt-oss-c", key: "k2" };
    // A fake provider world: one handler per chain entry, a clock we control.
    const world = (handlers: Record<string, () => Response | Promise<Response>>, chain: Provider[] = [G, Q, O]) => {
      const seen: string[] = [];
      const bodies: Record<string, unknown>[] = [];
      let reserved = 0;
      let clock = 1_000_000;
      const cfg: LlmConfig = {
        chain,
        health: newHealth(),
        now: () => clock,
        fetch: (async (url: string | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          const id = String(url).includes("google") ? `gemini:${decodeURIComponent(String(url).split("/models/")[1]!.split(":")[0]!)}` : `groq:${body.model}`;
          seen.push(id);
          bodies.push(body);
          return handlers[id]!();
        }) as typeof fetch,
        reserve: async () => { reserved++; return true; },
      };
      return { cfg, seen, bodies, tick: (ms: number) => { clock += ms; }, reserved: () => reserved, ask: () => proposeJson("s", "u", cfg, never) };
    };
    const gem = (text: string) => () => Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 50 } });
    const groq = (text: string) => () => Response.json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 800, completion_tokens: 40 } });
    const status = (code: number, headers: Record<string, string> = {}, body = "{}") => () => new Response(body, { status: code, headers });
    const ok = '{"intent":"search"}';

    let w = world({ "gemini:gem-a": gem(ok) });
    let out = await w.ask();
    check("first entry answers: one attempt", [out.ok && out.provider, out.attempts, w.seen, w.reserved()], ["gemini:gem-a", 1, ["gemini:gem-a"], 1]);

    // Routing by language (LLM_CHAIN_HINGLISH): Devanagari or a word that is never English → that chain.
    {
      const main = [O, Q];
      const hi = [Q, O];
      check("routing: English → the main chain", routeChain("villa in goa with a pool under 10k", main, hi), main);
      check("routing: Hinglish → the Hindi / Hinglish chain", routeChain("goa mein villa chahiye 10k tak", main, hi), hi);
      check("routing: Devanagari → the Hindi / Hinglish chain", routeChain("गोवा में विला चाहिए", main, hi), hi);
      check("routing: a mixed follow-up with a Hinglish word → the Hindi / Hinglish chain", routeChain("ok, budget 8000 tak", main, hi), hi);
      check("routing: not configured → always the main chain", routeChain("goa mein villa chahiye", main, null), main);
      check("routing: English words that look Hindi are not ('ho', 'se', 'log' are not in the list)", isHindiOrHinglish("log cabin, ho hum, se of goa"), false);
      // quota on the routed first model: the other one answers, within the same two attempts
      w = world({ "groq:qwen-b": status(429, { "retry-after": "60" }), "groq:gpt-oss-c": groq(ok) }, routeChain("goa mein villa chahiye", main, hi));
      out = await w.ask();
      check("routing: Qwen out of quota on a Hinglish message → GPT-OSS answers", [out.ok && out.provider, out.attempts, w.seen], ["groq:gpt-oss-c", 2, ["groq:qwen-b", "groq:gpt-oss-c"]]);
      w = world({ "groq:gpt-oss-c": status(429, { "retry-after": "60" }), "groq:qwen-b": groq(ok) }, routeChain("villa in goa", main, hi));
      out = await w.ask();
      check("routing: GPT-OSS out of quota on an English message → Qwen answers", [out.ok && out.provider, out.attempts, w.seen], ["groq:qwen-b", 2, ["groq:gpt-oss-c", "groq:qwen-b"]]);
    }

    w = world({ "gemini:gem-a": status(404), "groq:qwen-b": groq(ok) });
    out = await w.ask();
    check("a retired model (404) falls back — not only 429", [out.ok && out.provider, out.attempts, w.seen], ["groq:qwen-b", 2, ["gemini:gem-a", "groq:qwen-b"]]);
    out = await w.ask();
    check("…and is then skipped without spending an attempt", [out.ok && out.provider, out.attempts, w.seen.length], ["groq:qwen-b", 1, 3]);
    w.tick(10 * 60_000 + 1);
    await w.ask();
    check("…until its long cooldown ends", w.seen.at(-2), "gemini:gem-a");

    w = world({ "gemini:gem-a": gem("I think the customer wants…"), "groq:qwen-b": groq('```json\n{"intent":"other"}\n```') });
    out = await w.ask();
    check("non-JSON from the first entry falls back; a fenced answer is accepted", [out.ok && out.provider, out.ok && out.json], ["groq:qwen-b", { intent: "other" }]);

    w = world({ "gemini:gem-a": status(500), "groq:qwen-b": status(503), "groq:gpt-oss-c": groq(ok) });
    out = await w.ask();
    check("both fail: exactly two attempts, never a third", [out.ok, out.attempts, w.seen, w.reserved()], [false, 2, ["gemini:gem-a", "groq:qwen-b"], 2]);

    // quota: a rate-limit answer opens the breaker for as long as the provider says
    w = world({ "gemini:gem-a": status(429, {}, JSON.stringify({ error: { details: [{ retryDelay: "37s" }] } })), "groq:qwen-b": status(429, { "retry-after": "20" }), "groq:gpt-oss-c": groq(ok) });
    out = await w.ask();
    check("two rate-limited entries do not use up the attempts: the third answers in the same request", [out.ok && out.provider, out.attempts, w.seen], ["groq:gpt-oss-c", 3, ["gemini:gem-a", "groq:qwen-b", "groq:gpt-oss-c"]]);
    out = await w.ask();
    check("next request skips both and uses the third — one attempt", [out.ok && out.provider, out.attempts, w.seen.slice(3)], ["groq:gpt-oss-c", 1, ["groq:gpt-oss-c"]]);
    w.tick(21_000);
    await w.ask();
    check("after its 20 s the second entry is tried again; the first (37 s) is still skipped", w.seen.at(-2), "groq:qwen-b");
    w.tick(20_000);
    const before37 = w.seen.length;
    await w.ask();
    check("after 37 s the first entry is tried again", w.seen[before37], "gemini:gem-a");
    w = world({ "gemini:gem-a": status(429), "groq:qwen-b": status(503), "groq:gpt-oss-c": status(500) });
    out = await w.ask();
    check("a rate-limit refusal is free, but two failures that take time still end the request (never a fourth call)", [out.ok, out.attempts, w.seen], [false, 3, ["gemini:gem-a", "groq:qwen-b", "groq:gpt-oss-c"]]);

    w = world({ "gemini:gem-a": status(429), "groq:qwen-b": status(429) }, [G, Q]);
    await w.ask();
    const calls = w.seen.length;
    out = await w.ask();
    check("every entry cooling down: 'unavailable', nothing called, nothing reserved, with a retry hint",
      [!out.ok && out.why, w.seen.length - calls, w.reserved(), !out.ok && (out.retryAfterMs ?? 0) > 0], ["unavailable", 0, 2, true]);

    w = world({ "gemini:gem-a": status(503), "groq:qwen-b": groq(ok) });
    await w.ask(); await w.ask();
    check("two transient failures do not open the breaker", w.seen.filter((s) => s === "gemini:gem-a").length, 2);
    await w.ask();
    await w.ask();
    check("three in a row do: the flaky entry is skipped for a while", w.seen.filter((s) => s === "gemini:gem-a").length, 3);

    w = world({ "groq:gpt-oss-c": groq(ok), "groq:qwen-b": groq(ok) }, [O]);
    await w.ask();
    check("reasoning models get a low effort and a larger output budget", [w.bodies[0]!.reasoning_effort, w.bodies[0]!.max_completion_tokens, w.bodies[0]!.max_tokens], ["low", 1500, undefined]);
    w = world({ "groq:qwen-b": groq(ok) }, [Q]);
    await w.ask();
    check("other models keep the small output cap", [w.bodies[0]!.reasoning_effort, w.bodies[0]!.max_tokens], [undefined, 500]);

    w = world({ "gemini:gem-a": gem("{}") });
    w.cfg.reserve = async () => false;
    out = await w.ask();
    check("daily cap reached: no call is made", [!out.ok && out.why, w.seen], ["cap", []]);
    check("no usable entry: unconfigured", (await proposeJson("s", "u", { ...w.cfg, chain: [] }, never) as { why?: string }).why, "unconfigured");
    const gone = new AbortController();
    gone.abort();
    w = world({ "gemini:gem-a": gem("{}") });
    out = await proposeJson("s", "u", w.cfg, gone.signal);
    check("client already gone: nothing is spent", [out.ok, w.reserved()], [false, 0]);

    // the chain only ever holds what was configured
    check("chain parsing keeps order and drops entries without a key", parseChain("groq:qwen/q, gemini:g-lite ,groq:openai/gpt-oss-120b", { groq: "k" }).map(providerId), ["groq:qwen/q", "groq:openai/gpt-oss-120b"]);
    check("an unknown provider kind is ignored — nothing else is ever called", parseChain("openai:gpt-9,groq:qwen/q", { groq: "k", gemini: "k" }).map(providerId), ["groq:qwen/q"]);
  });

  await group("post-release-dates-off", async () => {
    // Post-release review 2026-11-28: with dated search off, no path may keep dates in the search state,
    // including the retry after another instance moved the state, and a confirmed change.
    const saved = (name: string) => JSON.parse(readFileSync(`eval/contract/${name}.json`, "utf8")) as { status: number; body: { data: Listing[] } };
    const key = "g:g_77777777-review";
    const DATES = { checkIn: "2026-12-20", checkOut: "2026-12-23" };
    const hasDates = (s: SearchState | undefined) => !!s && ("checkIn" in s || "checkOut" in s || "nights" in s);
    const make = (racer?: (s: SearchState) => SearchState) => {
      const inner = memoryStore();
      let raced = !racer;
      const store: StateStore = {
        load: (k) => inner.load(k),
        commit: async (k, rev, next) => {
          if (!raced) { raced = true; const d = await inner.load(k); await inner.commit(k, d?.rev ?? 0, { state: racer!(d?.state ?? {}), pending: null, updatedAt: Date.parse("2026-11-25T06:00:00Z") }); }
          return inner.commit(k, rev, next);
        },
      };
      const urls: string[] = [];
      const deps: PipelineDeps = {
        now: () => new Date("2026-11-25T06:00:00Z"),
        store,
        catalog: { baseUrl: "https://api.example/api/v1", fetch: (async (u: string | URL) => { urls.push(String(u)); return Response.json(saved("place-goa").body, { status: 200 }); }) as typeof fetch },
        llm: async () => ({ ok: false, why: "failed", attempts: 0, errors: ["no model in this check"] }),
      };
      return { inner, deps, urls };
    };
    const turn = (deps: PipelineDeps, extra: Partial<Parameters<typeof handleTurn>[0]>) =>
      handleTurn({ message: "Set filters", key, readMode: "off", dated: false, ...extra }, deps, new AbortController().signal);

    {
      // the op itself carries dates; another instance commits between this turn's read and its write
      const w = make((s) => ({ ...s, guests: { min: 4 } }));
      const r = await turn(w.deps, { op: { set: { place: "goa", ...DATES } as never } });
      const stored = w.inner.docs.get(key)?.state;
      check("conflict retry, dates in the op: retry reply, the other change kept, no dates stored or returned",
        [r.outcome, stored?.guests, hasDates(stored), hasDates(r.state)], ["retry", { min: 4 }, false, false]);
    }
    {
      // the newer state written by the other instance carries dates (an older bundle / a flip of RAG_DATED_SEARCH)
      const w = make((s) => ({ ...s, place: "goa", ...DATES }));
      const r = await turn(w.deps, { op: { set: { guests: { min: 2 } } } });
      const stored = w.inner.docs.get(key)?.state;
      check("conflict retry, dates in the newer state: not kept while dated search is off",
        [r.outcome, stored?.guests, hasDates(stored), hasDates(r.state)], ["retry", { min: 2 }, false, false]);
    }
    {
      // a "yes" to a stored confirm whose change has dates (written by chat mode): applied without the dates
      const w = make();
      const proposal = validateProposal({ intent: "search", set: { place: "goa", ...DATES } });
      await w.inner.commit(key, 0, { state: {}, pending: { kind: "confirm", proposal: proposal as Proposal, question: "Change your search?" }, updatedAt: new Date("2026-11-25T06:00:00Z").getTime() });
      const r = await handleTurn({ message: "yes", key, readMode: "apply", dated: false }, w.deps, new AbortController().signal);
      const stored = w.inner.docs.get(key)?.state;
      check("confirmed change with dates, dated search off: place applied, no dates kept or sent",
        [stored?.place, hasDates(stored), hasDates(r.state), w.urls.some((u) => /[?&](from|to)=/.test(u))], ["goa", false, false, false]);
    }
  });

  await group("post-release-cards", async () => {
    // Post-release review 2026-11-28: a listing with no bedrooms / guests value was drawn as "0 bedrooms".
    const goa = JSON.parse(readFileSync("eval/contract/place-goa.json", "utf8")).body as { data: Listing[] };
    const rows = structuredClone(goa.data).map(({ bedrooms: _b, guests: _g, ...rest }) => rest);
    const deps: PipelineDeps = {
      now: () => new Date("2026-11-25T06:00:00Z"),
      store: memoryStore(),
      catalog: { baseUrl: "https://api.example/api/v1", fetch: (async () => Response.json({ ...goa, data: rows }, { status: 200 })) as typeof fetch },
      llm: async () => ({ ok: false, why: "failed", attempts: 0, errors: ["none"] }),
    };
    const r = await handleTurn({ message: "Set filters", key: "g:g_88888888-cards", readMode: "off", dated: false, op: { set: { place: "goa" } } }, deps, new AbortController().signal);
    check("unknown guests / bedrooms are left off the card (never 0), and the final check agrees",
      [r.cards.length > 0, r.cards.every((c) => !("bedrooms" in c) && !("guests" in c)), r.log.defects], [true, true, []]);
  });

  await group("post-release-canary", async () => {
    // Post-release review 2026-11-28: /api/chat, /history and /config derive the caller the same way and make one
    // canary decision, so a visitor who gets the safe reply is never offered filter controls or search state.
    const sign = (await import("jsonwebtoken")).default.sign;
    const env = { ...process.env };
    process.env.JWT_SECRET = "verify-rag-only";
    const hdr = (token?: string, xff?: string) => new Headers({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...(xff ? { "x-forwarded-for": xff } : {}) });
    const uid = "65a1b2c3d4e5f6a7b8c9d0e1";
    const good = sign({ userId: uid }, "verify-rag-only");
    const forged = sign({ userId: uid }, "someone-else");
    const shortId = sign({ userId: "aaaaaaaaaaaa" }, "verify-rag-only"); // a 12-character ObjectId-able string
    check("signed-in: the account key, the guest id ignored", chatIdentity(hdr(good), "g_12345678-abcd").key, `u:${uid}`);
    const f = chatIdentity(hdr(forged), "g_12345678-abcd");
    check("a token that does not verify: a guest of its own, never the plain guest thread", [f.userId, f.guestId === guestIdForUnverifiedToken("g_12345678-abcd", forged), f.key?.startsWith("g:g_12345678-abcd-t")], [null, true, true]);
    check("a verified token whose id is not a 24-hex ObjectId is anonymous (history used to read it as an account)", chatIdentity(hdr(shortId), "g_12345678-abcd").userId, null);
    check("a guest id over 100 characters is no identity", chatIdentity(hdr(), "g_" + "a".repeat(99)).guestId, null);
    check("no identity: the canary falls back to the address", chatIdentity(hdr(undefined, "203.0.113.9"), undefined), { userId: null, guestId: null, key: null, ip: "203.0.113.9" });
    process.env.RAG_PIPELINE = "v2";
    const g = chatIdentity(hdr(), "g_12345678-abcd");
    process.env.RAG_V2_PERCENT = "0";
    check("canary 0 %: nobody gets the pilot", [pilotLive(g), canaryPercent()], [false, 0]);
    process.env.RAG_V2_PERCENT = "10%";
    check("unreadable percent: nobody (never everyone)", [pilotLive(g), canaryPercent()], [false, 0]);
    delete process.env.RAG_V2_PERCENT;
    check("percent unset: everyone", [pilotLive(g), canaryPercent()], [true, 100]);
    process.env.RAG_PIPELINE = "shadow";
    check("shadow: the pilot answers nobody", pilotLive(g), false);
    process.env = env;
  });

  await group("post-release-store-deadline", async () => {
    // Post-release review 2026-11-28: a stalled database held a filter button 10-25 s (staging drill), past the turn's
    // 9 s deadline. Every state call now waits 2.5 s at most, and once per turn.
    const goa = JSON.parse(readFileSync("eval/contract/place-goa.json", "utf8")).body;
    const hang = () => new Promise<never>(() => {});
    const timed = async <T,>(p: Promise<T>, capMs: number) => {
      const t0 = performance.now();
      const out = await Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), capMs))]);
      return { out, ms: Math.round(performance.now() - t0) };
    };
    const deps = (store: StateStore): PipelineDeps => ({
      now: () => new Date("2026-11-25T06:00:00Z"),
      store,
      catalog: { baseUrl: "https://api.example/api/v1", fetch: (async () => Response.json(goa, { status: 200 })) as typeof fetch },
      llm: async () => ({ ok: false, why: "failed", attempts: 0, errors: ["no model in this check"] }),
    });
    const turn = (store: StateStore, signal: AbortSignal) =>
      handleTurn({ message: "Set filters", key: "g:g_88888888-review", readMode: "off", dated: false, op: { set: { place: "goa" } } }, deps(store), signal);

    {
      const r = await timed(turn({ load: hang, commit: hang }, new AbortController().signal), 6000);
      check("state read never answers: the turn ends by itself in about 2.5 s, nothing searched or promised",
        [r.out === "hung" ? "hung" : r.out.outcome, r.ms >= 2400 && r.ms < 3000], ["not_processed", true]);
    }
    {
      // without the latch the failed write retried like a version conflict: a second read and a third write
      const inner = memoryStore();
      let calls = 0;
      const r = await timed(turn({ load: (k) => { calls++; return inner.load(k); }, commit: () => { calls++; return hang(); } }, new AbortController().signal), 12000);
      check("state write never answers: one 2.5 s wait, then the retry reply (no match claimed); the store is not asked again",
        [r.out === "hung" ? "hung" : r.out.outcome, r.ms >= 2400 && r.ms < 3000, calls, inner.docs.size], ["retry", true, 2, 0]);
    }
    {
      // the bound is time only: a customer who leaves mid-search still has what they asked kept
      const inner = memoryStore();
      const gone = new AbortController();
      const leaving: PipelineDeps = { ...deps(inner), catalog: { baseUrl: "https://api.example/api/v1", fetch: (async () => { gone.abort(); throw new DOMException("aborted", "AbortError"); }) as typeof fetch } };
      const r = await handleTurn({ message: "Set filters", key: "g:g_88888888-left", readMode: "off", dated: false, op: { set: { place: "goa" } } }, leaving, gone.signal);
      check("customer leaves mid-search: no cards, and the change is still stored",
        [r.outcome, r.cards.length, inner.docs.get("g:g_88888888-left")?.state.place], ["unavailable", 0, "goa"]);
    }
    {
      const cfg: LlmConfig = { chain: [{ kind: "groq", model: "m", key: "k" }], health: newHealth(), fetch: (async () => Response.json({})) as typeof fetch, reserve: hang };
      const r = await timed(proposeJson("s", "u", cfg, AbortSignal.timeout(800)), 6000);
      check("daily-cap counter never answers: no model call, the turn ends at its deadline",
        [r.out === "hung" ? "hung" : r.out.ok, r.ms < 1300], [false, true]);
    }
  });

  await group("haiku-drafting", async () => {
    // Haiku 5.5 as the only drafting model (2026-11-28). The fake API answers in the documented shapes (claude-api
    // skill, shared/error-codes.md; @anthropic-ai/sdk 1.14 error fields); a real out-of-credit answer can't be
    // produced without draining the account.
    check("402 billing_error is billing", failureKind(402, "billing_error"), "billing");
    check("429 with error_code enforced_spend_limit_reached is billing, not a rate limit", failureKind(429, "rate_limit_error", "enforced_spend_limit_reached"), "billing");
    check("402 with a linked-org spend limit is billing", failureKind(402, null, "linked_organization_spend_limit_reached"), "billing");
    check("the older 400 'credit balance is too low' is billing", failureKind(400, "invalid_request_error", null, "Your credit balance is too low to access the Anthropic API."), "billing");
    check("529 is overloaded; 422 is the request's own answer; 500 and a plain 429 are other",
      [failureKind(529, "overloaded_error"), failureKind(422), failureKind(500, "api_error"), failureKind(429, "rate_limit_error")], ["overloaded", "content", "other", "other"]);

    const HAIKU: Provider = { kind: "anthropic", model: "claude-haiku-5-5", key: "k" };
    type Reply = () => Response;
    const ok = (text = '{"intent":"search"}', cacheRead = 2034, cacheWrite = 0): Reply => () => Response.json({
      id: "msg_x", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 136, output_tokens: 120, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
    });
    const refusal: Reply = () => Response.json({ id: "msg_r", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } });
    const err = (status: number, type: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Reply => () =>
      Response.json({ type: "error", error: { type, message: `${type} (test)`, ...extra } }, { status, headers });
    const world = (script: Reply[]) => {
      let clock = 5_000_000, calls = 0, reserved = 0;
      const recorded: unknown[] = [];
      const cfg: LlmConfig = {
        chain: [HAIKU], health: newHealth(), now: () => clock,
        fetch: (async () => { const r = script[Math.min(calls, script.length - 1)]!; calls++; return r(); }) as typeof fetch,
        reserve: async () => { reserved++; return true; },
        record: (u) => recorded.push(u),
      };
      return { cfg, ask: () => proposeJson("s", "u", cfg, new AbortController().signal), tick: (ms: number) => { clock += ms; }, calls: () => calls, reserved: () => reserved, recorded, open: () => (cfg.health!.openUntil.get("anthropic:claude-haiku-5-5") ?? 0) - clock };
    };

    {
      const w = world([ok()]);
      const r = await w.ask();
      check("healthy: one call, the draft JSON, cache read reported and recorded for spend",
        [r.ok, r.ok && r.cacheRead, w.calls(), w.recorded], [true, 2034, 1, [{ provider: "anthropic:claude-haiku-5-5", tokensIn: 2170, tokensOut: 120, cacheRead: 2034, cacheWrite: 0 }]]);
    }
    {
      // out of credit → refilled
      const w = world([err(402, "billing_error"), ok()]);
      const first = await w.ask();
      const paused = w.open();
      const callsAfterFirst = w.calls(), reservedAfterFirst = w.reserved();
      const during = await w.ask();
      check("out of credit: the attempt fails, drafting pauses 10 minutes", [first.ok, !first.ok && first.why, paused], [false, "failed", 10 * 60_000]);
      check("during the pause: answered at once, no call, nothing counted against the daily cap",
        [!during.ok && during.why, w.calls() - callsAfterFirst, w.reserved() - reservedAfterFirst], ["unavailable", 0, 0]);
      w.tick(10 * 60_000 + 1);
      const after = await w.ask();
      const again = await w.ask();
      check("after a refill: the first message past the pause reaches Haiku and drafting is back, no restart or flag change",
        [after.ok, again.ok, w.open() <= 0], [true, true, true]);
    }
    {
      const w = world([err(429, "rate_limit_error", { details: { error_code: "enforced_spend_limit_reached" } })]);
      await w.ask();
      check("monthly spend cap (429, no retry-after): treated as billing, 10 minutes, not retried every minute", w.open(), 10 * 60_000);
    }
    {
      const w = world([err(429, "rate_limit_error", {}, { "retry-after": "20" })]);
      await w.ask();
      check("rate limit: rests for the time Anthropic asks (retry-after 20 s)", w.open(), 20_000);
    }
    {
      const w = world([err(529, "overloaded_error")]);
      await w.ask();
      check("overloaded (529): rests 30 s at once instead of after three failures", w.open(), 30_000);
    }
    {
      const w = world([refusal]);
      for (let i = 0; i < 5; i++) await w.ask();
      check("five refusals in a row never pause drafting for everyone", [w.open() <= 0, w.calls()], [true, 5]);
    }
    {
      const w = world([ok("this is not json")]);
      for (let i = 0; i < 5; i++) await w.ask();
      const r = await w.ask();
      check("unusable answers never pause drafting either; each is just that message's failure", [w.open() <= 0, w.calls(), !r.ok && r.why], [true, 6, "failed"]);
    }
    {
      // Haiku 5.5 with thinking off, production 2026-11-28, run 2 of 3 for "four friends … quiet villa in goa with a pool":
      // a right object, then visible self-correction and a worse second object. The first object is the reading.
      const prod = '{"intent":"search","set":{"place":"goa","guests":{"min":4},"propertyType":"villa","amenitiesAll":["pool"]},"remove":[],"soft":null}\n\nWait — the schema lists "soft" as a field inside remove. Corrected output:\n\n{"intent":"search","set":{"place":"goa"},"remove":[{"field":"soft","value":"quiet"}]}';
      check("parse: the first object of a self-correcting answer, the rest ignored", parseJson(prod), { intent: "search", set: { place: "goa", guests: { min: 4 }, propertyType: "villa", amenitiesAll: ["pool"] }, remove: [], soft: null });
      check("parse: a code fence and leading words around the object", parseJson('Here you go:\n```json\n{"intent":"greeting"}\n```'), { intent: "greeting" });
      check("parse: braces and quotes inside strings do not end the object", parseJson('{"said":"a {quiet} \\"villa\\" }","n":1} trailing'), { said: 'a {quiet} "villa" }', n: 1 });
      let threw = false;
      try { parseJson("no json here"); } catch { threw = true; }
      check("parse: an answer with no object is still a failure", threw, true);
      const w = world([ok(prod)]);
      const r = await w.ask();
      check("a self-correcting Haiku answer becomes a draft instead of 'couldn't read that'", [r.ok, r.ok && (r.json as { set?: { place?: string } }).set?.place], [true, "goa"]);
    }
    {
      const w = world([err(500, "api_error")]);
      await w.ask(); await w.ask();
      const two = w.open();
      await w.ask();
      check("server errors: still three in a row before a 30 s rest", [two <= 0, w.open()], [true, 30_000]);
    }
    {
      // only Haiku, whatever the language: LLM_CHAIN names it and LLM_CHAIN_HINGLISH stays unset (null chain)
      const keys = { anthropic: "a", groq: "g", gemini: "m", xai: "x" };
      const main = parseChain("anthropic:claude-haiku-5-5", keys);
      const picks = ["villa in goa for 4 under 10k", "goa mein villa chahiye 10k tak", "गोवा में विला चाहिए"].map((m) => routeChain(m, main, null).map(providerId));
      check("English, Hinglish and Hindi all go to Haiku only, with other providers' keys present", picks, [["anthropic:claude-haiku-5-5"], ["anthropic:claude-haiku-5-5"], ["anthropic:claude-haiku-5-5"]]);
      check("no Anthropic key: no chain at all (drafting answers 'use the filter buttons'), never another provider", parseChain("anthropic:claude-haiku-5-5", { groq: "g" }), []);
    }

    // Editing a draft before Apply: the form opens with the chosen lines filled in; the rest rides along.
    {
      const today = "2026-11-28";
      const current: SearchState = { place: "goa", guests: { min: 4 } };
      const next: SearchState = { place: "goa", guests: { min: 6 }, amenitiesAll: ["pool"], unsupported: ["private pool"], price: { max: 15000 } };
      const draft = draftOf("6 log, pool, private pool, 15k tak", current, next, false, [], today);
      const plan = draftEditPlan(current, draft.lines);
      check("draft edit: the form shows the draft's guests, budget and pool; the current place stays",
        [plan.form.place, plan.form.guests, plan.form.priceMax, plan.form.amenities], ["goa", "6", "15000", ["pool"]]);
      check("draft edit: 'private pool' can't be a form field, so it rides along as written", plan.carry.map((l) => l.op), [{ unsupported: ["private pool"] }]);
      // the guest changes guests to 5 in the editor, then saves
      const d = diffOp(plan.start, { ...plan.form, guests: "5" });
      const op = "error" in d ? null : mergeOps([...plan.carry.map((l) => l.op), d.op]);
      const applied = op ? applyDelta(current, validateProposal({ intent: "search", set: op.set ?? {}, unset: op.unset, remove: op.remove, unsupported: op.unsupported, soft: op.soft, reset: op.reset === true }) as Proposal) : null;
      check("draft edit saved: the guest's own change wins, the rest of the draft and the current search are kept",
        applied && { place: applied.place, guests: applied.guests, price: applied.price, amenitiesAll: applied.amenitiesAll, unsupported: applied.unsupported },
        { place: "goa", guests: { min: 5 }, price: { max: 15000 }, amenitiesAll: ["pool"], unsupported: ["private pool"] });
      // a new search in the draft: compared against nothing, so a save keeps everything the form shows
      const fresh = draftOf("new search: jaipur villa", current, { place: "jaipur", propertyType: "villa" }, true, [], today);
      const p2 = draftEditPlan(current, fresh.lines);
      const d2 = diffOp(p2.start, p2.form);
      const op2 = "error" in d2 ? null : mergeOps([...p2.carry.map((l) => l.op), d2.op]);
      check("draft edit of a new search: reset first, then the whole form", [op2?.reset, op2?.set?.place, op2?.set?.propertyType, op2?.set?.guests], [true, "jaipur", "villa", undefined]);
      const none = draftEditPlan(current, []);
      check("draft edit with every line unticked: the editor opens on the current search", [none.form, none.carry.length], [formOf(current), 0]);
    }
  });

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`} — ${passes} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
