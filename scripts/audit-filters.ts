// Independent retrieval audit of filters mode, against the live (read-only) site search.
//
// Random sessions of filter-button ops (seeded, reproducible) go through the real pipeline (handleTurn,
// readMode "off", dated false). A separate checker, written here from the raw listing fields and NOT using
// requirements.ts, re-derives for every turn: the search state the ops should give, which stays meet every
// filter, and what the reply may say. Any disagreement is printed with its evidence.
//
//   npx tsx scripts/audit-filters.ts [sessions=300] [seed=7]
//
// What it asserts on every search turn:
//  - no model call (buttons are model-free);
//  - the state equals the ops applied by hand (replacement is exact, nothing else changes);
//  - every card is a stay that meets every filter (or, in a "not verified" reply, nothing is disproved), with
//    the listing's own title / price / capacity / place; never more than 8;
//  - "N stays match" equals the independent count; a "nothing matches" reply has no stay that meets everything;
//  - every "N stays meet everything except X" line has exactly that count;
//  - nearby stays are never called matches; an unknown place is never "no stays";
//  - no availability claim, no rupee amount that is not a filter or a listed base price.

import { handleTurn, type PipelineDeps, type TurnResult } from "../src/lib/rag/pipeline";
import { memoryStore } from "../src/lib/rag/state";
import type { Listing, SearchState } from "../src/lib/rag/types";

const SESSIONS = Number(process.argv[2] ?? 300);
let seed = Number(process.argv[3] ?? 7);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const CATALOG = (process.env.CATALOG_API_URL ?? "https://server.majesticescape.in/api/v1").replace(/\/+$/, "");

// ── the live search, cached per URL (a few dozen real requests in total) ──
const cache = new Map<string, Promise<{ status: number; body: unknown }>>();
let apiCalls = 0;
let turnBodies: { url: string; body: { data?: Listing[]; search?: { mode?: string } } }[] = [];
const liveFetch = (async (url: string | URL) => {
  const u = String(url);
  if (!cache.has(u)) {
    apiCalls++;
    cache.set(u, fetch(u).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })));
    await new Promise((r) => setTimeout(r, 250)); // gentle on the live API
  }
  const hit = await cache.get(u)!;
  turnBodies.push({ url: u, body: hit.body as never });
  return Response.json(hit.body, { status: hit.status });
}) as typeof fetch;

let llmCalls = 0;
const store = memoryStore();
const deps: PipelineDeps = {
  now: () => new Date(),
  store,
  catalog: { baseUrl: CATALOG, fetch: liveFetch },
  llm: async () => { llmCalls++; return { ok: false, why: "failed", attempts: 0, errors: ["the audit has no model"] }; },
};

// ── the independent checker ──
type Verdict = "yes" | "no" | "unknown";
const AMENITIES = ["wifi", "free-parking", "air-conditioning", "kitchen", "tv", "workspace", "pool", "washing", "bbq", "firepit", "outdoor-dining", "patio", "beach", "lake", "pool-table", "first-aid", "smoke-alarm", "fire-extinguisher"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function judge(l: Listing & Record<string, unknown>, s: SearchState): { verdict: "confirmed" | "possible" | "excluded"; failed: string[]; open: string[] } {
  const res: [string, Verdict][] = [];
  const range = (key: string, v: unknown, r?: { min?: number; max?: number }) => {
    if (!r || (r.min === undefined && r.max === undefined)) return;
    const n = num(v);
    res.push([key, n === null ? "unknown" : (r.min !== undefined && n < r.min) || (r.max !== undefined && n > r.max) ? "no" : "yes"]);
  };
  if (s.guests) { const need = Math.max(s.guests.min ?? 0, s.guests.max ?? 0); const c = num(l.guests); res.push(["guests", c === null ? "unknown" : c >= need ? "yes" : "no"]); }
  range("bedrooms", l.bedrooms, s.bedrooms); range("beds", l.beds, s.beds); range("bathrooms", l.bathrooms, s.bathrooms); range("price", l.basePrice, s.price);
  if (s.propertyType) { const t = typeof l.propertyType === "string" ? l.propertyType.trim().toLowerCase() : ""; res.push(["propertyType", !t ? "unknown" : t === s.propertyType.toLowerCase() ? "yes" : "no"]); }
  if (s.placeType) { const t = l.placeType; res.push(["placeType", typeof t !== "string" || !t ? "unknown" : (s.placeType === "entire") === (t === "entire") ? "yes" : "no"]); }
  const am = Array.isArray(l.amenities) ? (l.amenities as string[]) : null;
  for (const a of s.amenitiesAll ?? []) res.push([`amenity:${a}`, am === null ? "unknown" : am.includes(a) ? "yes" : "no"]);
  if (s.amenitiesAny?.length) res.push(["amenityAny", am === null ? "unknown" : s.amenitiesAny.some((a) => am.includes(a)) ? "yes" : "no"]);
  for (const a of s.amenitiesNone ?? []) res.push([`no:${a}`, am === null ? "unknown" : am.includes(a) ? "no" : "yes"]);
  if (s.petsAllowed) res.push(["pets", Array.isArray(l.selectedRules) && (l.selectedRules as string[]).includes("no_pets") ? "no" : "unknown"]); // never provable
  if (s.instantBook) { const v = (l.bookingType as { instantBook?: unknown } | undefined)?.instantBook; res.push(["instantBook", v === true ? "yes" : v === false ? "no" : "unknown"]); }
  if (s.selfCheckIn) res.push(["selfCheckIn", Array.isArray(l.occupancy) ? ((l.occupancy as string[]).includes("self-check-in") ? "yes" : "no") : "unknown"]);
  if (s.cancellation) { const v = (l.cancellationType as Record<string, unknown> | undefined)?.[s.cancellation]; res.push(["cancellation", v === true ? "yes" : v === false ? "no" : "unknown"]); }
  for (const u of s.unsupported ?? []) res.push([`unsupported:${u}`, "unknown"]);
  if (l.status !== undefined && l.status !== "active") res.push(["status", "no"]);
  const failed = res.filter(([, v]) => v === "no").map(([k]) => k);
  const open = res.filter(([, v]) => v === "unknown").map(([k]) => k);
  return { verdict: failed.length ? "excluded" : open.length ? "possible" : "confirmed", failed, open };
}
const showable = (l: Listing) => typeof l.title === "string" && !!l.title.trim() && typeof l.basePrice === "number";

// ── the ops a guest can make with the buttons, and the state they must give ──
const PLACES = ["goa", "north goa", "south goa", "calangute", "anjuna", "morjim", "arpora", "assagao", "panaji", "mapusa", "baga", "candolim", "manali", "jaipur", "udaipur", "lonavala", "coorg", "xyzzyville"];
const TYPES = ["villa", "apartment", "house", "guesthouse", "hotel", "farmhouse", "tent"];
type Op = { set?: Record<string, unknown>; unset?: string[]; remove?: string[]; unsupported?: string[]; reset?: true };
function randomOp(s: SearchState): Op {
  const r = rnd();
  if (r < 0.12) return { set: { place: pick(PLACES) }, unset: ["place"] };
  if (r < 0.22) return { set: { guests: { min: 1 + Math.floor(rnd() * 16) } }, unset: ["guests"] };
  if (r < 0.34) { const lo = rnd() < 0.3 ? 1000 * (1 + Math.floor(rnd() * 15)) : undefined; const hi = rnd() < 0.85 ? 1000 * (3 + Math.floor(rnd() * 70)) : undefined; const p = { ...(lo !== undefined ? { min: lo } : {}), ...(hi !== undefined && (lo === undefined || hi >= lo) ? { max: hi } : {}) }; return Object.keys(p).length ? { set: { price: p }, unset: ["price"] } : { unset: ["price"] }; }
  if (r < 0.42) return { set: { bedrooms: { min: 1 + Math.floor(rnd() * 5) } }, unset: ["bedrooms"] };
  if (r < 0.46) return { set: { bathrooms: { min: 1 + Math.floor(rnd() * 4) } }, unset: ["bathrooms"] };
  if (r < 0.54) return { set: { propertyType: pick(TYPES) }, unset: ["propertyType"] };
  if (r < 0.58) return { set: { placeType: pick(["entire", "room"]) }, unset: ["placeType"] };
  if (r < 0.70) return { set: { amenitiesAll: [pick(AMENITIES)] } };
  if (r < 0.73) return { set: { amenitiesNone: [pick(AMENITIES)] } };
  if (r < 0.76) return { set: { amenitiesAny: [pick(AMENITIES), pick(AMENITIES)].filter((x, i, a) => a.indexOf(x) === i) } };
  if (r < 0.79) return { set: { [pick(["petsAllowed", "instantBook", "selfCheckIn"])]: true } };
  if (r < 0.82) return { set: { cancellation: pick(["flexible", "moderate", "strict"]) }, unset: ["cancellation"] };
  if (r < 0.85) return { unsupported: [pick(["private pool", "sea view", "near the beach"])] };
  const lists = [...(s.amenitiesAll ?? []), ...(s.amenitiesNone ?? []), ...(s.unsupported ?? [])];
  if (r < 0.93 && lists.length) return { remove: [pick(lists)] };
  const scalars = (["place", "guests", "price", "bedrooms", "propertyType", "placeType", "petsAllowed", "instantBook", "selfCheckIn", "cancellation"] as const).filter((k) => s[k] !== undefined);
  if (r < 0.98 && scalars.length) return { unset: [pick(scalars)] };
  return { reset: true };
}
const without = (xs: string[] | undefined, ys: string[]) => { const v = (xs ?? []).filter((x) => !ys.includes(x)); return v.length ? v : undefined; };
function expectState(prev: SearchState, op: Op): SearchState {
  let s: Record<string, unknown> = op.reset ? {} : { ...prev };
  for (const k of op.unset ?? []) delete s[k];
  if (op.remove) for (const k of ["amenitiesAll", "amenitiesAny", "amenitiesNone", "unsupported"]) s[k] = without(s[k] as string[], op.remove);
  for (const [k, v] of Object.entries(op.set ?? {})) {
    if (k === "amenitiesAll") { s.amenitiesAll = [...new Set([...((s.amenitiesAll as string[]) ?? []), ...(v as string[])])]; s.amenitiesNone = without(s.amenitiesNone as string[], v as string[]); }
    else if (k === "amenitiesNone") { s.amenitiesNone = [...new Set([...((s.amenitiesNone as string[]) ?? []), ...(v as string[])])]; s.amenitiesAll = without(s.amenitiesAll as string[], v as string[]); s.amenitiesAny = without(s.amenitiesAny as string[], v as string[]); }
    else if (k === "amenitiesAny") s.amenitiesAny = (v as string[]).length === 1 ? undefined : v;
    else s[k] = v;
    if (k === "amenitiesAny" && (v as string[]).length === 1) s.amenitiesAll = [...new Set([...((s.amenitiesAll as string[]) ?? []), ...(v as string[])])];
  }
  if (op.unsupported) s.unsupported = [...new Set([...((s.unsupported as string[]) ?? []), ...op.unsupported])];
  s = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
  return s as SearchState;
}
const norm = (s: SearchState) => { const { shownIds: _a, consentFor: _b, ...r } = s; return JSON.stringify(Object.keys(r).sort().map((k) => [k, Array.isArray((r as Record<string, unknown>)[k]) ? [...((r as Record<string, unknown[]>)[k])].sort() : (r as Record<string, unknown>)[k]])); };

// ── run ──
const findings: string[] = [];
const outcomes: Record<string, number> = {};
let turns = 0, cardsChecked = 0, countClaims = 0, nearMissLines = 0;
const fail = (where: string, what: string) => { if (findings.length < 60) findings.push(`${where}: ${what}`); };

function audit(where: string, r: TurnResult, state: SearchState) {
  outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  if (/Available for your dates/.test(r.text) || r.cards.some((c) => c.availability)) fail(where, "availability claimed with dated search off");
  if (r.cards.length > 8) fail(where, `${r.cards.length} cards`);
  const searchBody = [...turnBodies].reverse().find((b) => b.url.includes("/properties"))?.body;
  const rows = turnBodies.flatMap((b) => b.body?.data ?? []) as (Listing & Record<string, unknown>)[];
  const byId = new Map(rows.map((l) => [l._id, l]));
  const mode = searchBody?.search?.mode;
  const amounts = new Set<number>([state.price?.min, state.price?.max, ...rows.map((l) => l.basePrice)].filter((x): x is number => typeof x === "number"));
  for (const m of r.text.matchAll(/₹\s?([\d,]+)/g)) if (!amounts.has(Number(m[1]!.replace(/,/g, "")))) fail(where, `amount ₹${m[1]} not a filter nor a listed price`);
  for (const c of r.cards) {
    cardsChecked++;
    const l = byId.get(c._id);
    if (!l) { fail(where, `card ${c._id} not in the search results`); continue; }
    if (c.title !== l.title || c.basePrice !== l.basePrice || c.guests !== (l.guests ?? 0) || c.bedrooms !== (l.bedrooms ?? 0)) fail(where, `card ${c._id} differs from its listing`);
    const j = judge(l, state);
    if (c.group === "match" && j.verdict !== "confirmed") fail(where, `card "${l.title}" shown as a match but ${j.verdict} (failed ${j.failed.join(",")}; open ${j.open.join(",")})`);
    if (c.group !== "match" && j.verdict === "excluded") fail(where, `card "${l.title}" shown (${c.group}) but disproved by ${j.failed.join(",")}`);
    if (c.group === "possible" && !/not verified/i.test(c.note ?? "")) fail(where, `unverified card "${l.title}" without its label`);
  }
  if (!["matches", "no_match", "possible_ask", "possible_shown", "incomplete"].includes(r.outcome)) {
    if (r.outcome === "nearby" || r.outcome === "nearby_none") {
      if (/\b(stay matches|stays match)\b/.test(r.text)) fail(where, "nearby stays called matches");
      if (r.cards.some((c) => c.group !== "alternative")) fail(where, "nearby card not labelled as an alternative");
    }
    if (r.outcome === "unrecognised_place" && r.cards.length) fail(where, "cards for an unrecognised place");
    if (/no stays|nothing matches/i.test(r.text) && r.outcome === "unrecognised_place") fail(where, "an unknown place said as 'no stays'");
    return;
  }
  // in-place outcomes: the independent count
  const inPlace = rows.filter((l) => showable(l));
  const uniq = [...new Map(inPlace.map((l) => [l._id, l])).values()];
  const confirmed = uniq.filter((l) => judge(l, state).verdict === "confirmed");
  const possible = uniq.filter((l) => judge(l, state).verdict === "possible");
  if (mode && !["place", "text", "all"].includes(mode)) return;
  const m = r.text.match(/(\d+) stays? match/);
  if (m) { countClaims++; if (Number(m[1]) !== confirmed.length) fail(where, `says ${m[1]} match, independent count ${confirmed.length}`); }
  if (r.outcome === "matches" && confirmed.length === 0) fail(where, "'matches' with no stay meeting every filter");
  if (r.outcome !== "matches" && r.outcome !== "incomplete" && confirmed.length > 0) fail(where, `${r.outcome} although ${confirmed.length} stays meet every filter`);
  if (r.outcome === "no_match" && possible.length > 0) fail(where, `'nothing matches' although ${possible.length} stays are only unverified`);
  for (const nm of r.text.matchAll(/(\d+) stays? meets? everything except (?:the budget|the group size|"([^"]+)")/g)) {
    nearMissLines++;
    const n = Number(nm[1]);
    const only = (key: (f: string) => boolean) => uniq.filter((l) => { const j = judge(l, state); return j.failed.length === 1 && key(j.failed[0]!) && j.open.length === 0; }).length;
    const label = nm[2];
    // budget and group size: the exact count; any other label: no more stays than fail exactly one filter
    const got = /the budget/.test(nm[0]) ? only((f) => f === "price") : /group size/.test(nm[0]) ? only((f) => f === "guests") : only(() => true);
    if (/the budget|group size/.test(nm[0]) && got !== n) fail(where, `near-miss line "${nm[0]}" but the independent count is ${got}`);
    if (label && got < n) fail(where, `near-miss line "${nm[0]}" but at most ${got} stays fail only one filter`);
  }
}

(async () => {
  const t0 = Date.now();
  for (let i = 0; i < SESSIONS; i++) {
    const key = `g:audit-${i}`;
    let expected: SearchState = {};
    const steps = 1 + Math.floor(rnd() * 5);
    for (let k = 0; k < steps; k++) {
      const op = k === 0 ? { set: { place: pick(PLACES), ...(rnd() < 0.7 ? { guests: { min: 1 + Math.floor(rnd() * 10) } } : {}) }, unset: ["place", "guests"] } : randomOp(expected);
      const next = expectState(expected, op);
      turnBodies = [];
      const before = llmCalls;
      const r = await handleTurn({ message: "button", key, op, readMode: "off", dated: false }, deps, new AbortController().signal);
      turns++;
      const where = `s${i}t${k} ${JSON.stringify(op)}`;
      if (llmCalls !== before) fail(where, "a button reached the model");
      if (r.outcome === "not_processed") { fail(where, `refused: ${r.text}`); continue; }
      if (norm(r.state) !== norm(next)) fail(where, `state ${norm(r.state)} expected ${norm(next)}`);
      expected = next;
      audit(where, r, expected);
      // the consent question answered by its button ("Yes, show them" is a fast path, never a model)
      if (r.outcome === "possible_ask" && rnd() < 0.6) {
        turnBodies = [];
        const y = await handleTurn({ message: "Yes, show them", key, readMode: "off", dated: false }, deps, new AbortController().signal);
        turns++;
        if (llmCalls !== before) fail(where + " +yes", "the consent answer reached the model");
        if (y.outcome !== "possible_shown" && y.outcome !== "nearby") fail(where + " +yes", `consent gave ${y.outcome}`);
        audit(where + " +yes", y, expected);
      }
    }
  }
  console.log(`audit: ${SESSIONS} sessions, ${turns} turns, ${apiCalls} live search requests, ${cardsChecked} cards checked, ${countClaims} "N stays match" claims, ${nearMissLines} near-miss lines, ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log("outcomes:", JSON.stringify(outcomes));
  console.log(`model calls: ${llmCalls}`);
  console.log(findings.length ? `FINDINGS (${findings.length}${findings.length === 60 ? "+" : ""}):\n` + findings.join("\n") : "FINDINGS: none");
  process.exit(findings.length ? 1 : 0);
})();
