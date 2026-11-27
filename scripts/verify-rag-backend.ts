// Integration checks for the search pipeline (src/lib/rag) against a REAL local
// server.me and a REAL local MongoDB. The model is scripted (as in verify-rag.ts),
// so these checks are about the pipeline and the backend contract, not a model.
//
// Run:  npm run verify:rag-backend            (optionally: -- <group> to run one group)
//
// Needs the rig: an in-memory MongoDB replica set, server.me at production code on
// port 5405 and the fixtures of eval/fixtures (README there). LOCAL ONLY:
//   RAG_BACKEND_URL           default http://127.0.0.1:5405/api/v1   — refused unless 127.0.0.1/localhost
//   RAG_VERIFY_MONGODB_URI    default mongodb://127.0.0.1:27417/?replicaSet=rs0 — refused unless local
// State checks run in their own uniquely named database and drop only that one.
// A FAIL here that shows the backend behaving differently from what the pipeline
// assumes is a finding to report — do not loosen the check to hide it.

import { existsSync, readFileSync } from "node:fs";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { fetchCandidates, parsePage, scopeOf, searchUrl, type CatalogResult } from "../src/lib/rag/catalog";
import { istToday } from "../src/lib/rag/dates";
import type { LlmResult } from "../src/lib/rag/llm";
import { handleTurn, type PipelineDeps, type TurnResult } from "../src/lib/rag/pipeline";
import { mongoStore, type StateDoc, type StateStore } from "../src/lib/rag/state";
import type { Listing, SearchState } from "../src/lib/rag/types";
import { keyLockCount, withKeyLock } from "../src/lib/rateLimit";
import { addDays, buildFixtures } from "../eval/fixtures/generate";

// ── local-only guards ───────────────────────────────────────────────────────
const LOCAL_MONGO = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/([^?@/]*))?(\?.*)?$/;
function localMongo(raw: string, name?: string): { uri: string; db: string } {
  const m = LOCAL_MONGO.exec(raw);
  if (!m) throw new Error("refusing non-local MongoDB URI");
  const db = name ?? m[3] ?? "";
  return { uri: `mongodb://${m[1]}${m[2] ?? ""}/${db}${m[4] ?? ""}`, db };
}
function localBackend(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== "http:" || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") || u.username || u.password) {
    throw new Error("refusing non-local backend URL");
  }
  return raw.replace(/\/+$/, "");
}
const refuses = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };

const BACKEND = localBackend(process.env.RAG_BACKEND_URL ?? "http://127.0.0.1:5405/api/v1");
const VERIFY_DB = `rag_verify_${Date.now().toString(36)}`;
const VERIFY = localMongo(process.env.RAG_VERIFY_MONGODB_URI ?? "mongodb://127.0.0.1:27417/?replicaSet=rs0", VERIFY_DB);

let failures = 0;
let passes = 0;
const only = process.argv[2];
const findings: string[] = [];

function check(label: string, actual: unknown, expected: unknown): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passes++; return true; }
  console.error(`  FAIL  ${label}\n        expected ${e}\n        got      ${a}`);
  failures++;
  return false;
}
function group(name: string, fn: () => void | Promise<void>): Promise<void> {
  if (only && only !== name) return Promise.resolve();
  const before = failures;
  const start = passes;
  return Promise.resolve(fn()).then(() => {
    console.log(`${failures === before ? "PASS" : "FAIL"}  ${name}  (${passes - start} checks)`);
  });
}

// ── the seeded world ────────────────────────────────────────────────────────
const SEEDED = "eval/fixtures/data/seeded.json";
if (!existsSync(SEEDED)) {
  console.error(`${SEEDED} not found — seed the rig first (eval/fixtures/README.md).`);
  process.exit(1);
}
const seeded = JSON.parse(readFileSync(SEEDED, "utf8")) as { dbUri: string; dbName: string; today: string; seededAt: string; liveHoldExpiresAt: string | null };
const RIG = localMongo(seeded.dbUri);
if (!/^rag_rig_[a-z0-9]+$/.test(RIG.db)) throw new Error("refusing: the seeded database is not a rag_rig_* database");

const today = seeded.today;
const fx = buildFixtures(today, new Date(seeded.seededAt));
const D = (n: number) => addDays(today, n);
const never = new AbortController().signal;

interface FxListing {
  _id: { toHexString(): string };
  title: string; propertyType: string; placeType: string; guests: number; bedrooms?: number; beds: number; bathrooms: number;
  basePrice?: number; amenities: string[]; selectedRules: string[]; occupancy: string[]; status: string; ban: boolean;
  bookingType: Record<string, boolean>; cancellationType: Record<string, boolean>; address: { city: string; state: string };
}
const listings = fx.listings as unknown as FxListing[];
const byId = new Map(listings.map((l) => [l._id.toHexString(), l]));
const codeOf = new Map(Object.entries(fx.ids).map(([code, id]) => [id, code]));
const isPublic = (l: FxListing) => l.status === "active" && l.ban !== true;
const publicIn = (state: string) => listings.filter((l) => isPublic(l) && l.address.state === state).map((l) => l._id.toHexString()).sort();
const ID = (...codes: string[]) => codes.map((c) => fx.ids[c]!).sort();
const codes = (ids: string[]) => ids.map((i) => codeOf.get(i) ?? i).sort();
const HIDDEN = ["J12", "J13", "G-INACTIVE", "A10"];

let backendCalls = 0;
/** Every backend call that did not answer 200: "http 503", "TimeoutError", "TypeError ECONNRESET" → count. */
const backendTrouble = new Map<string, number>();
const trouble = (what: string) => backendTrouble.set(what, (backendTrouble.get(what) ?? 0) + 1);
const countingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  backendCalls++;
  try {
    const res = await fetch(url, init);
    if (res.status !== 200) trouble(`http ${res.status}`);
    return res;
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    trouble(`${e.name}${e.cause?.code ? ` ${e.cause.code}` : ""}`);
    throw err;
  }
}) as typeof fetch;
const catalog = { baseUrl: BACKEND, fetch: countingFetch };
const search = (place?: string, checkIn?: string, checkOut?: string) => fetchCandidates({ place, checkIn, checkOut }, catalog, never);
const rowIds = (r: CatalogResult) => (r.kind === "ok" ? r.rows.map((x) => x._id).sort() : [`failed: ${r.why}`]);
const brief = (r: CatalogResult) => (r.kind === "ok" ? [r.scope, r.complete, r.rows.length, r.total, r.pages] : ["failed", r.why]);
const raw = async (query: string) => {
  const res = await fetch(`${BACKEND}/properties/search-properties?${query}`, { headers: { Accept: "application/json" } });
  return { status: res.status, body: (await res.json().catch(() => null)) as { data?: Listing[]; search?: { mode?: string; reason?: string } } | null };
};

async function main(): Promise<void> {
  const mongo = new MongoClient(VERIFY.uri, { serverSelectionTimeoutMS: 5000 });
  await mongo.connect();
  const db: Db = mongo.db(VERIFY.db);
  const rig = mongo.db(RIG.db); // read-only here: the documents behind a finding
  const store = mongoStore(db.collection("ai_chat_state"));
  const stateOf = async (key: string) => db.collection<{ _id: string; rev: number; state: SearchState; pending: unknown }>("ai_chat_state").findOne({ _id: key });
  const run = Date.now().toString(36);
  let keySeq = 0;
  const newKey = () => `g:g_rig-${run}-${++keySeq}`;

  // A scripted "model": the reading for each message is fixed.
  const S = (o: Record<string, unknown>) => ({ intent: "search", ...o });
  const world = (script: Record<string, unknown>, over: Partial<PipelineDeps> = {}) => {
    const calls = { llm: 0 };
    const deps: PipelineDeps = {
      now: () => new Date(`${today}T06:30:00.000Z`), // noon in India on the fixtures' "today"
      store,
      catalog,
      llm: async (_s, user) => {
        calls.llm++;
        const msg = JSON.parse(user).message as string;
        if (!(msg in script)) throw new Error(`no scripted reading for "${msg}"`);
        return { ok: true, json: script[msg], provider: "gemini", tokensIn: 0, tokensOut: 0, attempts: 1 } as LlmResult;
      },
      ...over,
    };
    return { deps, calls, say: (message: string, key: string, signal: AbortSignal = never) => handleTurn({ message, key }, deps, signal) };
  };
  const cards = (r: TurnResult) => codes(r.cards.map((c) => c._id));

  try {
    await group("preflight", async () => {
      check("guard: an Atlas URI is refused", refuses(() => localMongo("mongodb+srv://user:pw@cluster0.example.mongodb.net/db")), true);
      check("guard: a look-alike host is refused", refuses(() => localMongo("mongodb://127.0.0.1.example.com:27017/db")), true);
      check("guard: credentials@remote is refused", refuses(() => localMongo("mongodb://localhost@db.example.com/db")), true);
      check("guard: a remote backend is refused", [refuses(() => localBackend("https://server.majesticescape.in/api/v1")), refuses(() => localBackend("http://127.0.0.1.example.com/api/v1"))], [true, true]);
      check("guard: the local defaults pass", [refuses(() => localMongo("mongodb://127.0.0.1:27417/?replicaSet=rs0")), refuses(() => localBackend("http://localhost:5405/api/v1"))], [false, false]);
      const ping = await raw("limit=1").catch((err: Error) => ({ status: 0, body: null, err: err.message }));
      check("the local backend answers", ping.status, 200);
      check("the fixtures were seeded for today in India (re-seed if not)", today, istToday(new Date()));
      check("the live hold of case A3 has at least 3 minutes left (re-seed if not)", !!seeded.liveHoldExpiresAt && Date.parse(seeded.liveHoldExpiresAt) - Date.now() > 180_000, true);
      check("the backend reads the seeded database", await rig.collection("listingproperties").countDocuments({}), fx.listings.length);
    });

    await group("contract", async () => {
      // Every mode the classifier (catalog.ts scopeOf) handles, produced by the real backend.
      const all = await search();
      const everyPublic = listings.filter(isPublic).map((l) => l._id.toHexString()).sort();
      check("no place → mode all → everywhere; every public stay exactly once, over two pages", [brief(all), rowIds(all)], [["everywhere", true, everyPublic.length, everyPublic.length, 2], everyPublic]);
      const goa = await search("goa");
      check("place: 'goa' → place, complete, every row of the 56-stay place exactly once", [brief(goa), rowIds(goa)], [["place", true, 56, 56, 2], publicIn("Goa")]);
      check("place: no id is returned twice", goa.kind === "ok" ? new Set(goa.rows.map((r) => r._id)).size : -1, 56);
      const p1 = await raw(new URL(searchUrl(BACKEND, { place: "goa" }, 1)).search.slice(1));
      const p2 = await raw(new URL(searchUrl(BACKEND, { place: "goa" }, 2)).search.slice(1));
      const ids1 = (p1.body?.data ?? []).map((r) => r._id);
      const ids2 = (p2.body?.data ?? []).map((r) => r._id);
      check("paging: page 1 has 50 rows, page 2 the remaining 6, no overlap", [ids1.length, ids2.length, ids2.filter((i) => ids1.includes(i)).length], [50, 6, 0]);
      check("paging: the default page (no limit) is 16 — why the pipeline always sends limit=50", (await raw("location=goa")).body?.data?.length, 16);
      check("paging: limit above 50 is capped at 50", (await raw("location=goa&limit=500")).body?.data?.length, 50);

      const anjuna = await search("anjuna");
      check("place: 'anjuna' (a town) → place, named Anjuna, rows are the Anjuna stays", [anjuna.kind === "ok" && anjuna.scope, anjuna.kind === "ok" && anjuna.placeName, rowIds(anjuna)],
        ["place", "Anjuna", listings.filter((l) => isPublic(l) && l.address.city === "Anjuna").map((l) => l._id.toHexString()).sort()]);
      const typo = await search("jaipr");
      check("place: a typo is corrected and flagged", typo.kind === "ok" ? [typo.scope, typo.corrected, typo.placeName, typo.rows.length] : typo.why, ["place", true, "Jaipur", 12]);
      const name = await search("zephyr lantern");
      check("name/text: a stay's title → mode text → scope name, that stay only", [brief(name), codes(rowIds(name))], [["name", true, 1, 1, 1], ["G-NAME"]]);
      const nearby = await search("ajmer");
      check("nearby: a known place with no stays → the backend widens by itself; rows are the Jaipur stays with a distance",
        [brief(nearby), rowIds(nearby), nearby.kind === "ok" && nearby.rows.every((r) => typeof r.distanceKm === "number" && r.distanceKm > 100 && r.distanceKm < 250)],
        [["nearby", true, 12, 12, 1], publicIn("Rajasthan"), true]);
      const far = await search("kolkata");
      check("nearby: nothing within 250 km → nearby with zero rows (not 'unrecognised')", brief(far), ["nearby", true, 0, 0, 1]);
      const vague = await search("hills");
      check("all after a place was sent: 'hills' → unrecognised, and the rows are the WHOLE catalogue", brief(vague), ["unrecognised", true, everyPublic.length, everyPublic.length, 2]);
      const gibberish = await search("zzqxv");
      check("an unknown word → mode text with zero rows → scope name", brief(gibberish), ["name", true, 0, 0, 1]);
      const near = await raw("lat=26.84&lng=80.92&limit=50&page=1");
      const nearPage = parsePage(near.status, near.body);
      check("near: lat/lng (never sent by the pipeline) → mode 'near', which the classifier maps to nearby", typeof nearPage === "string" ? nearPage : [nearPage.mode, scopeOf(nearPage.mode, false)], ["near", "nearby"]);

      // Hidden listings never appear, whatever the route to them.
      const hidden = ID(...HIDDEN);
      const seen: string[] = [];
      for (const r of [all, goa, await search("jaipur"), await search("lucknow"), nearby, vague, await search("hidden inactive villa"), await search("hidden banned villa"), await search("availability deactivated later")]) {
        if (r.kind !== "ok") seen.push(`failed: ${r.why}`);
        else seen.push(...r.rows.map((x) => x._id).filter((i) => hidden.includes(i)));
      }
      check("inactive, banned and delisted listings never appear (place, all, nearby, by their own title)", seen, []);
      check("every returned row says status active", all.kind === "ok" ? all.rows.filter((r) => r.status !== "active").length : -1, 0);

      // The fields the validator and the cards read.
      const NEEDED = ["_id", "title", "propertyType", "placeType", "guests", "bedrooms", "beds", "bathrooms", "amenities", "basePrice", "bookingType", "cancellationType", "selectedRules", "occupancy", "status", "address"];
      const lacking = all.kind === "ok"
        ? all.rows.map((r) => [codeOf.get(r._id) ?? r._id, NEEDED.filter((k) => !(k in r))] as const).filter(([, miss]) => miss.length > 0).sort((x, y) => (x[0] < y[0] ? -1 : 1))
        : [];
      check("rows carry every field requirements.ts reads — except the two listings that lack one in the database", lacking, [["J08", ["bedrooms"]], ["J09", ["basePrice"]]]);
      const view = (x: unknown) => { const l = (x ?? {}) as Partial<FxListing>; return {
        title: l.title, propertyType: l.propertyType, placeType: l.placeType, guests: l.guests, bedrooms: l.bedrooms, beds: l.beds, bathrooms: l.bathrooms, basePrice: l.basePrice,
        amenities: l.amenities, selectedRules: l.selectedRules, occupancy: l.occupancy, bookingType: l.bookingType, cancellationType: l.cancellationType, status: l.status,
        city: l.address?.city, state: l.address?.state,
      }; };
      const differing = all.kind === "ok" ? all.rows.filter((r) => JSON.stringify(view(r)) !== JSON.stringify(view(byId.get(r._id)))).map((r) => codeOf.get(r._id)) : ["failed"];
      check("every row's values equal the stored document (no masking, casting or defaulting on the way out)", differing, []);

      // Why the pipeline sends both dates or none, and validates them itself.
      const a1 = fx.ids.A1!;
      const has = async (q: string) => ((await raw(`location=lucknow&limit=50&page=1&${q}`)).body?.data ?? []).some((r) => r._id === a1);
      check("contract: a lone 'from' is ignored (the booked stay is still returned)", await has(`from=${D(10)}`), true);
      check("contract: equal dates are ignored", await has(`from=${D(10)}&to=${D(10)}`), true);
      check("contract: reversed dates are ignored", await has(`from=${D(13)}&to=${D(10)}`), true);
      check("contract: the real pair filters", await has(`from=${D(10)}&to=${D(13)}`), false);
      const bad = await fetchCandidates({ place: "lucknow", checkIn: "2027-02-30", checkOut: "2027-03-02" }, catalog, never);
      check("contract: an impossible date is HTTP 400 → failed, never an empty result", bad, { kind: "failed", why: "http 400" });
    });

    await group("requirements", async () => {
      const turn = async (message: string, reading: Record<string, unknown>) => world({ [message]: S(reading) }).say(message, newKey());
      const J = (o: Record<string, unknown>) => ({ place: "jaipur", ...o });

      // Budget boundary: 10000 is inside "under 10000", 10001 is not.
      let r = await turn("villas in jaipur for 8 under 10000", { set: J({ guests: { min: 8 }, price: { max: 10000 }, propertyType: "villa" }) });
      check("budget 10000: the ₹10,000 villa is in, the ₹10,001 villa is out", [r.outcome, cards(r)], ["matches", ["J01", "J03", "J08"]]);
      check("…the filters are shown back first", r.text.split("\n")[0], "Jaipur · 8 guests · up to ₹10,000/night · villa");
      check("…no dates → no availability claim", [r.cards.some((c) => c.availability), /Add your dates/.test(r.text)], [false, true]);
      r = await turn("villas in jaipur for 8 under 10001", { set: J({ guests: { min: 8 }, price: { max: 10001 }, propertyType: "villa" }) });
      check("budget 10001: both boundary villas are in", [r.outcome, cards(r)], ["matches", ["J01", "J02", "J03", "J08"]]);
      r = await turn("villas in jaipur for 8 under 9999", { set: J({ guests: { min: 8 }, price: { max: 9999 }, propertyType: "villa" }) });
      check("budget 9999: the ₹10,000 villa is out", [r.outcome, cards(r)], ["matches", ["J03", "J08"]]);
      r = await turn("stays in jaipur at least 10001 a night", { set: J({ price: { min: 10001 } }) });
      check("a minimum of 10001 excludes the ₹10,000 villa", [r.outcome, cards(r)], ["matches", ["J02", "J07"]]);

      // Capacity: "for N" needs a stay that sleeps at least N.
      r = await turn("stays in jaipur for 9", { set: J({ guests: { min: 9 } }) });
      check("9 guests: only stays that sleep 9+", [r.outcome, cards(r)], ["matches", ["J03", "J07"]]);
      r = await turn("stays in jaipur for 12", { set: J({ guests: { min: 12 } }) });
      check("12 guests: capacity equal to the group is enough", [r.outcome, cards(r)], ["matches", ["J07"]]);
      r = await turn("stays in jaipur for 13", { set: J({ guests: { min: 13 } }) });
      check("13 guests: nothing fits — said plainly, with the real maximum, and no cards", [r.outcome, r.cards.length, /the largest sleeps 12/i.test(r.text)], ["no_match", 0, true]);

      // Bedrooms: a plain count is a minimum; "exactly" is exact; missing data is never a match.
      r = await turn("stays in jaipur with 4 bedrooms", { set: J({ bedrooms: { min: 4, max: 4 } }) });
      check("4 bedrooms (a plain count = at least 4)", [r.outcome, cards(r), r.log.counts], ["matches", ["J01", "J02", "J03", "J07"], { confirmed: 4, possible: 1, excluded: 7 }]);
      r = await turn("stays in jaipur with exactly 4 bedrooms", { set: J({ bedrooms: { min: 4, max: 4 } }) });
      if (!check("exactly 4 bedrooms", [r.outcome, cards(r)], ["matches", ["J01", "J02"]])) {
        findings.push(`PIPELINE, not backend — "exactly 4 bedrooms" read as bedrooms {min:4,max:4} is answered with "${r.outcome}": understand.ts crossCheck counts the exact range's number twice (extractedNumbers pushes min and max) against one typed "4", so every "exactly N" request becomes a "numbers" clarification and the exact filter is never applied.`);
      }
      r = await turn("stays in jaipur with 2 to 4 bedrooms", { set: J({ bedrooms: { min: 2, max: 4 } }) });
      check("2–4 bedrooms: both ends are enforced", [r.outcome, cards(r)], ["matches", ["J01", "J02", "J04", "J10", "J11"]]);
      r = await turn("stays in jaipur with up to 2 bedrooms", { set: J({ bedrooms: { max: 2 } }) });
      check("up to 2 bedrooms", [r.outcome, cards(r)], ["matches", ["J04", "J05", "J06", "J14"]]);
      const w = world({ "villas in jaipur with 4 bedrooms under 9600": S({ set: J({ bedrooms: { min: 4 }, price: { max: 9600 }, propertyType: "villa" }) }) });
      const k = newKey();
      r = await w.say("villas in jaipur with 4 bedrooms under 9600", k);
      check("the listing with no `bedrooms` is NOT a match when bedrooms are required: ask first, show nothing", [r.outcome, r.cards.length, r.pending?.kind, r.text.includes(`can't verify "4+ bedrooms"`)], ["possible_ask", 0, "consent", true]);
      r = await w.say("yes", k);
      check("…and after a yes it is shown as not verified, never as a match", [r.outcome, cards(r), r.cards[0]?.group, r.cards[0]?.note, /stays? match/.test(r.text)], ["possible_shown", ["J08"], "possible", "not verified: 4+ bedrooms", false]);

      // Amenities: all, any, none.
      r = await turn("stays in jaipur with pool and bbq", { set: J({ amenitiesAll: ["pool", "bbq"] }) });
      check("amenities ALL: pool and bbq", [r.outcome, cards(r)], ["matches", ["J02", "J07"]]);
      r = await turn("stays in jaipur with lake or firepit", { set: J({ amenitiesAny: ["lake", "firepit"] }) });
      check("amenities ANY: lake or firepit", [r.outcome, cards(r)], ["matches", ["J03", "J07", "J10", "J11", "J14"]]);
      r = await turn("stays in jaipur without wifi", { set: J({ amenitiesNone: ["wifi"] }) });
      check("amenities NONE: without wifi (the banned no-wifi villa stays hidden)", [r.outcome, cards(r)], ["matches", ["J07", "J14"]]);

      // Near-duplicates and unshowable rows.
      r = await turn("stays in jaipur with lake", { set: J({ amenitiesAll: ["lake"] }) });
      check("two stays with the same title are two cards", [r.outcome, cards(r), r.cards.map((c) => c.title), r.cards.map((c) => c.basePrice).sort(), r.log.defects],
        ["matches", ["J10", "J11"], ["Saffron Courtyard Haveli", "Saffron Courtyard Haveli"], [7500, 7600], []]);
      r = await turn("villas in jaipur with pool for 6", { set: J({ guests: { min: 6 }, amenitiesAll: ["pool"], propertyType: "villa" }) });
      check("the listing with no price is never a card and is not counted", [r.outcome, cards(r), r.text.includes("3 stays match")], ["matches", ["J01", "J02", "J08"], true]);
      r = await turn("house in jaipur", { set: J({ propertyType: "house" }) });
      check("type is equality: 'house' is not guesthouse or farmhouse", [r.outcome, cards(r)], ["matches", ["J10", "J11"]]);
      r = await turn("a room in jaipur", { set: J({ placeType: "room" }) });
      check("a room: room, private and shared — never an entire place", [r.outcome, cards(r)], ["matches", ["J05", "J06", "J14"]]);

      // Scopes that are not the place asked.
      r = await turn("stays in ajmer", { set: { place: "ajmer" } });
      check("a widened place: alternatives with a distance, never matches", [r.outcome, r.cards.length, r.cards.every((c) => c.group === "alternative" && /km from Ajmer$/.test(c.note ?? "")), r.text.includes("No stays in Ajmer itself")], ["nearby", 8, true, true]);
      r = await turn("stays in hills", { set: { place: "hills" } });
      check("an unrecognised place: ask, show nothing (the backend returned the whole catalogue)", [r.outcome, r.cards.length, r.log.catalog], ["unrecognised_place", 0, { scope: "unrecognised", pages: 2, rows: 80, total: 80, complete: true }]);

      // A dated search, end to end: availability only from this turn's dated call.
      const from = D(10), to = D(13);
      const booked = new Set(fx.nights.filter((n) => { const d = (n.date as Date).toISOString().slice(0, 10); const exp = n.expiresAt as Date | null; return d >= from && d < to && (exp === null || exp.getTime() > Date.now()); }).map((n) => String(n.propertyId)));
      const free = publicIn("Uttar Pradesh").filter((i) => !booked.has(i));
      const msg = `stays in lucknow from ${from} to ${to}`;
      r = await turn(msg, { set: { place: "lucknow", checkIn: from, checkOut: to } });
      check("dated: exactly the stays whose nights are free in the ledger, each marked available", [r.outcome, cards(r), r.cards.every((c) => c.availability === "available"), r.text.includes("Available for your dates when checked just now")], ["matches", codes(free), true, true]);
    });

    await group("availability", async () => {
      const nightsOf = (from: string, to: string) => { const out: string[] = []; for (let d = from; d < to; d = addDays(d, 1)) out.push(d); return out; };
      const documents = async (listingId: string) => {
        const pid = new ObjectId(listingId);
        return {
          listing: await rig.collection("listingproperties").findOne({ _id: pid }, { projection: { title: 1, status: 1, ban: 1, delist: 1 } }),
          bookings: await rig.collection("bookings").find({ propertyId: pid }, { projection: { source: 1, action: 1, status: 1, paymentStatus: 1, checkIn: 1, checkOut: 1, holdExpiresAt: 1, "external.state": 1, "external.connectionId": 1 } }).toArray(),
          bookingnights: await rig.collection("bookingnights").find({ propertyId: pid }, { projection: { date: 1, bookingId: 1, kind: 1, expiresAt: 1 } }).sort({ date: 1 }).toArray(),
        };
      };
      for (const c of fx.cases) {
        const cal = await fetch(`${BACKEND}/booking/check-dates/${c.listingId}`).then(async (res) => ({ status: res.status, body: (await res.json().catch(() => null)) as { data?: string[]; code?: string } | null }));
        const taken = new Set(cal.body?.data ?? []);
        let rulesOk = 0, calendarOk = 0;
        for (const range of c.ranges) {
          const res = await search("lucknow", range.from, range.to);
          const offered = res.kind === "ok" && res.rows.some((x) => x._id === c.listingId);
          if (res.kind !== "ok" || res.scope !== "place" || !res.complete) check(`${c.code} ${range.label}: the dated search itself`, brief(res), "ok / place / complete");
          const okSearch = check(`${c.code} ${range.label} (${range.from} → ${range.to}): the search ${range.free ? "offers" : "does not offer"} the stay`, offered, range.free);
          const calendarFree = cal.status === 200 && nightsOf(range.from, range.to).every((n) => !taken.has(n));
          const okAgree = check(`${c.code} ${range.label} (${range.from} → ${range.to}): the search agrees with /booking/check-dates`, offered, calendarFree);
          if (okSearch) rulesOk++;
          if (okAgree) calendarOk++;
          if (!okSearch || !okAgree) {
            findings.push(
              `BACKEND availability — ${c.code}: ${c.what}\n  range ${range.from} → ${range.to} (${range.label})\n  search offers the stay: ${offered}; booking rules say free: ${range.free}; check-dates says free: ${calendarFree} (HTTP ${cal.status}, dates ${JSON.stringify([...taken].sort())})\n  documents: ${JSON.stringify(await documents(c.listingId))}`
            );
          }
        }
        if (c.code === "A10") check("A10: check-dates refuses the delisted stay (404 LISTING_NOT_PUBLIC)", [cal.status, cal.body?.code], [404, "LISTING_NOT_PUBLIC"]);
        const n = c.ranges.length;
        console.log(`      ${c.code.padEnd(3)} search = booking rules ${rulesOk}/${n} · search = check-dates ${calendarOk}/${n}${calendarOk === n ? "  AGREES" : "  DISAGREES"}  — ${c.what}`);
      }
      // Looking at calendars must not have fetched anything: the rig pauses calendar sync.
      const attempts = await rig.collection("externalcalendars").find({}, { projection: { "sync.lastAttemptAt": 1, "sync.leaseToken": 1 } }).toArray();
      const seededAttempts = fx.calendars.map((cdoc) => ((cdoc.sync as { lastAttemptAt: Date }).lastAttemptAt).toISOString()).sort();
      check("no calendar feed was fetched by the calendar views (calendar_sync_paused is honoured)",
        [attempts.map((x) => (x.sync as { lastAttemptAt: Date }).lastAttemptAt.toISOString()).sort(), attempts.every((x) => (x.sync as { leaseToken: unknown }).leaseToken === null)], [seededAttempts, true]);
      // By name with dates: a booked stay comes back as zero rows — the reply must not say it does not exist.
      const byName = await search("availability paid booking", D(10), D(13));
      check("a booked stay searched by its name with dates: scope name, zero rows", brief(byName), ["name", true, 0, 0, 1]);
      const w = world({ [`availability paid booking ${D(10)} to ${D(13)}`]: S({ set: { place: "availability paid booking", checkIn: D(10), checkOut: D(13) } }) });
      const r = await w.say(`availability paid booking ${D(10)} to ${D(13)}`, newKey());
      check("…and the reply says it may be booked, not that it does not exist", [r.outcome, /it may be booked then/i.test(r.text)], ["name_not_found", true]);
    });

    await group("state", async () => {
      const script = {
        "stays in jaipur for 8": S({ set: { place: "jaipur", guests: { min: 8 } } }),
        "stays in jaipur with pool": S({ set: { place: "jaipur", amenitiesAll: ["pool"] } }),
        "under 10000": S({ set: { price: { max: 10000 } } }),
        "with pool": S({ set: { amenitiesAll: ["pool"] } }),
        "stays in lucknow": S({ set: { place: "lucknow" } }),
        "villas in jaipur for 8 under 10000": S({ set: { place: "jaipur", guests: { min: 8 }, price: { max: 10000 }, propertyType: "villa" } }),
        "stays in goa for 4": S({ set: { place: "goa", guests: { min: 4 } } }),
      };
      const req = (s: SearchState | undefined) => (({ place, guests, price, amenitiesAll, propertyType }) => ({ place, guests, price, amenitiesAll, propertyType }))(s ?? {});
      const locked = (key: string, fn: () => Promise<TurnResult>) => withKeyLock(`ai:${key}`, fn); // as src/app/api/chat/route.ts

      // 1. Same identity, two turns at the same instant, through the route's lock.
      let w = world(script);
      let key = newKey();
      await w.say("stays in jaipur for 8", key);
      let [a, b] = await Promise.all([locked(key, () => w.say("under 10000", key)), locked(key, () => w.say("with pool", key))]);
      let doc = await stateOf(key);
      check("lock: both turns ran, in arrival order, neither asked for a resend", [a.outcome, cards(a), b.outcome, cards(b)], ["matches", ["J01", "J03", "J08"], "matches", ["J01", "J08"]]);
      check("lock: both changes are in the stored state; three commits", [req(doc?.state), doc?.rev], [{ place: "jaipur", guests: { min: 8 }, price: { max: 10000 }, amenitiesAll: ["pool"] }, 3]);

      // 2. No lock: both turns read the same version (held at a barrier so this is not left to timing).
      const barrier = (n: number): StateStore => {
        const loads: Promise<StateDoc | null>[] = [];
        let open!: () => void;
        const gate = new Promise<void>((res) => (open = res));
        return {
          load: (k) => { const p = store.load(k); loads.push(p); if (loads.length >= n) open(); return gate.then(() => Promise.all(loads)).then(() => p); },
          commit: (k, rev, next) => store.commit(k, rev, next),
        };
      };
      key = newKey();
      await w.say("stays in jaipur for 8", key);
      w = world(script, { store: barrier(2) });
      [a, b] = await Promise.all([w.say("under 10000", key), w.say("with pool", key)]);
      doc = await stateOf(key);
      check("no lock: the version conflict is detected — exactly one turn asks for a resend", [a.outcome, b.outcome].filter((o) => o === "retry").length, 1);
      check("no lock: neither change is lost; the loser re-applied its change to the newer state", [req(doc?.state), doc?.rev, doc?.pending], [{ place: "jaipur", guests: { min: 8 }, price: { max: 10000 }, amenitiesAll: ["pool"] }, 3, null]);

      // 3. No lock, no document yet: two first turns race on the insert (duplicate key → conflict).
      key = newKey();
      w = world(script, { store: barrier(2) });
      [a, b] = await Promise.all([w.say("stays in jaipur for 8", key), w.say("stays in jaipur with pool", key)]);
      doc = await stateOf(key);
      check("first-write race: exactly one resend, both changes kept", [[a.outcome, b.outcome].filter((o) => o === "retry").length, req(doc?.state), doc?.rev],
        [1, { place: "jaipur", guests: { min: 8 }, amenitiesAll: ["pool"] }, 2]);

      // 4. Two identities at the same instant never see each other's state.
      w = world(script);
      const guest = newKey();
      const user = `u:${run.padStart(24, "0").slice(-24).replace(/[^a-f0-9]/g, "a")}`;
      await Promise.all([locked(guest, () => w.say("stays in jaipur for 8", guest)), locked(user, () => w.say("stays in lucknow", user))]);
      const next = await locked(guest, () => w.say("with pool", guest));
      check("identities: each document holds only its own requirements", [req((await stateOf(guest))?.state), req((await stateOf(user))?.state)],
        [{ place: "jaipur", guests: { min: 8 }, amenitiesAll: ["pool"] }, { place: "lucknow" }]);
      check("identities: the guest's next turn searched the guest's place", [next.outcome, next.text.split("\n")[0]], ["matches", "Jaipur · 8 guests · pool"]);

      // 5. The same message twice at the same instant.
      const once = newKey();
      const single = await w.say("villas in jaipur for 8 under 10000", once);
      key = newKey();
      [a, b] = await Promise.all([locked(key, () => w.say("villas in jaipur for 8 under 10000", key)), locked(key, () => w.say("villas in jaipur for 8 under 10000", key))]);
      check("duplicate message: both replies equal the single one", [[a.outcome, cards(a), a.text], [b.outcome, cards(b), b.text]], [[single.outcome, cards(single), single.text], [single.outcome, cards(single), single.text]]);
      check("duplicate message: the stored state equals the state after one", (await stateOf(key))?.state, (await stateOf(once))?.state);

      // 6. The customer goes away while page 2 of the catalogue is being fetched.
      key = newKey();
      const gone = new AbortController();
      const dying = ((url: string | URL | Request, init?: RequestInit) => { if (new URL(String(url)).searchParams.get("page") === "2") gone.abort(); return fetch(url, init); }) as typeof fetch;
      w = world(script, { catalog: { baseUrl: BACKEND, fetch: dying } });
      const cut = await w.say("stays in goa for 4", key, gone.signal);
      doc = await stateOf(key);
      check("abort mid-turn: no cards, no 'no stays' wording, the search is reported as failed", [cut.outcome, cut.cards.length, cut.log.catalog, /no stays|nothing match/i.test(cut.text)], ["unavailable", 0, { failed: "aborted" }, false]);
      check("abort mid-turn: the state is whole — what was asked is kept, nothing half-written", [doc?.state, doc?.rev, doc?.pending], [{ place: "goa", guests: { min: 4 } }, 1, null]);
      w = world(script);
      const after = await w.say("with pool", key);
      check("abort mid-turn: the next turn continues from that state", [after.outcome === "matches" || after.outcome === "no_match", req((await stateOf(key))?.state), (await stateOf(key))?.rev], [true, { place: "goa", guests: { min: 4 }, amenitiesAll: ["pool"] }, 2]);

      check("every per-identity lock was released", keyLockCount(), 0);
    });

    await group("perf", async () => {
      // LOCAL measurement only (the guards above refuse any other host): 40 sessions × 5 turns,
      // scripted model (zero model latency), real backend, real MongoDB state, the route's lock.
      const [from, to] = [D(20), D(23)];
      const turns: [string, Record<string, unknown>][] = [
        ["villas in goa for 4", S({ set: { place: "goa", guests: { min: 4 }, propertyType: "villa" } })],
        ["under 15000", S({ set: { price: { max: 15000 } } })],
        ["with pool", S({ set: { amenitiesAll: ["pool"] } })],
        ["actually jaipur", S({ set: { place: "jaipur" } })],
        [`from ${from} to ${to}`, S({ set: { checkIn: from, checkOut: to } })],
      ];
      const script = Object.fromEntries(turns);
      const ms: number[] = [];
      const outcomes = new Map<string, number>();
      const callsBefore = backendCalls;
      backendTrouble.clear();
      // Per turn of the script, summed over the sessions: backend calls made, pages of the
      // search the reply was built on, model calls, and how the message was read.
      const perTurn = turns.map(() => ({ calls: 0, pages: 0, model: 0, read: new Map<string, number>() }));
      const started = performance.now();
      await Promise.all(Array.from({ length: 40 }, async () => {
        const key = newKey();
        let mine = 0;
        const w = world(script, { catalog: { baseUrl: BACKEND, fetch: ((u: string | URL | Request, init?: RequestInit) => { mine++; return countingFetch(u, init); }) as typeof fetch } });
        for (const [i, [message]] of turns.entries()) {
          const [c0, m0, t0] = [mine, w.calls.llm, performance.now()];
          const r = await withKeyLock(`ai:${key}`, () => w.say(message, key));
          ms.push(performance.now() - t0);
          outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
          const t = perTurn[i]!;
          t.calls += mine - c0;
          t.model += w.calls.llm - m0;
          if (r.log.catalog && "pages" in r.log.catalog) t.pages += r.log.catalog.pages;
          const read = r.log.fast ?? "model";
          t.read.set(read, (t.read.get(read) ?? 0) + 1);
        }
      }));
      const wall = performance.now() - started;
      ms.sort((x, y) => x - y);
      const pct = (q: number) => Math.round(ms[Math.min(ms.length - 1, Math.ceil(q * ms.length) - 1)]!);
      const calls = backendCalls - callsBefore;
      const pages = perTurn.reduce((n, t) => n + t.pages, 0);
      const bad = ["not_processed", "retry", "unavailable", "clarify", "busy", "incomplete"].reduce((n, o) => n + (outcomes.get(o) ?? 0), 0);
      check("perf: all 200 turns completed with a search answer", [ms.length, bad], [200, 0]);
      check("perf: pages of the final search = 2 for each Goa turn, 1 for each Jaipur turn", perTurn.map((t) => t.pages / 40), [2, 2, 2, 1, 1]);
      console.log(`      perf (local only): 40 sessions x 5 turns = ${ms.length} turns in ${Math.round(wall)} ms wall; turn time p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${Math.round(ms[ms.length - 1]!)} ms`);
      console.log(`      perf: backend calls ${calls} = ${(calls / ms.length).toFixed(2)} per turn; ${pages} were pages of the search the reply was built on, ${calls - pages} were other calls (place checks made while reading a message, or retries); calls that did not answer 200: ${JSON.stringify(Object.fromEntries(backendTrouble))}; outcomes ${JSON.stringify(Object.fromEntries(outcomes))}`);
      for (const [i, [message]] of turns.entries()) {
        const t = perTurn[i]!;
        console.log(`      perf: turn ${i + 1} "${message}": ${t.calls / 40} backend calls (${t.pages / 40} pages), ${t.model / 40} model calls, read by ${JSON.stringify(Object.fromEntries(t.read))}`);
      }
    });
  } finally {
    await db.dropDatabase().catch(() => {});
    await mongo.close();
  }

  if (findings.length) {
    console.log(`\nFINDINGS (${findings.length}) — each failed check above that shows a real difference, with its evidence:`);
    for (const f of findings) console.log(`\n- ${f}`);
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
