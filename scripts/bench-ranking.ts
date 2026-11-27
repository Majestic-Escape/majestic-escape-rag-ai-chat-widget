// Offline ranking benchmark: once the hard requirements are met, in which ORDER
// should stays be shown? Compares the backend's newest-first order with vector
// similarity, BM25, their rank fusion, three "contextual" embedding variants
// and a keyword heuristic, against ONE annotator's graded labels
// (eval/ranking/queries.json, written before any ranking was computed).
//
//   npm run bench:ranking               every table (no network once embeddings are cached)
//   npm run bench:ranking -- --detail   also each query's top 3 per method
//
// Embeddings come from the embedding endpoint only and are cached in
// eval/ranking/.cache/embeddings.json (git-ignored), so a re-run is free.
// Read eval/ranking/REPORT.md before quoting a number from here: 19 listings,
// 40 queries, one annotator.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildPropertyText } from "../src/lib/embedder";
import { amenitiesNamed } from "../src/lib/rag/guards";

const DIR = "eval/ranking";
const CACHE = `${DIR}/.cache/embeddings.json`;
const MODEL = "gemini-embedding-001";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`;
const SLOTS = 8; // cards shown per answer
const RRF_K = 60; // MongoDB $rankFusion's constant
const BM25_K1 = 1.2, BM25_B = 0.75; // Lucene / Atlas Search defaults
const PACE_MS = 750;
const BOOT = 10000; // bootstrap resamples
const DRAWS = 200; // random pools / random orders per query
const DETAIL = process.argv.includes("--detail");

// keys: .env.local of this checkout, else the canonical checkout's (never printed)
for (const f of [".env.local", "../majestic-escape-rag-ai-chat-widget/.env.local"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
}

// ── data ─────────────────────────────────────────────────────────────────────

interface Row { _id: string; title?: string; description?: string; propertyType?: string; placeType?: string; amenities?: string[]; address?: { state?: string } }
interface Query { id: string; lang: "en" | "hinglish" | "hi"; kind: "soft" | "mixed"; text: string; rel: number[]; why2: Record<string, string> }

const rows = (JSON.parse(readFileSync(`${DIR}/listings.json`, "utf8")) as { data: Row[] }).data; // backend order = newest first
const labelFile = JSON.parse(readFileSync(`${DIR}/queries.json`, "utf8")) as { listings: { key: string; id: string }[]; queries: Query[] };
const queries = labelFile.queries;
const N = rows.length;
const ALL = rows.map((_, i) => i);
const KEY = labelFile.listings.map((l) => l.key);

assert.deepEqual(labelFile.listings.map((l) => l.id), rows.map((r) => r._id), "queries.json labels a different catalogue (or order) than listings.json");
for (const q of queries) {
  assert.equal(q.rel.length, N, `${q.id}: one grade per listing`);
  assert.ok(q.rel.every((r) => r === 0 || r === 1 || r === 2), `${q.id}: grades are 0/1/2`);
  const twos = KEY.filter((_, i) => q.rel[i] === 2);
  assert.ok(twos.length > 0, `${q.id}: at least one 2`);
  assert.deepEqual(Object.keys(q.why2).sort(), [...twos].sort(), `${q.id}: a reason for every 2 and only for 2s`);
}

const asProp = (r: Row) => r as unknown as Parameters<typeof buildPropertyText>[0];
const TEXT = {
  full: rows.map((r) => buildPropertyText(asProp(r))), // what production embeds (no reviews exist yet)
  nodesc: rows.map((r) => buildPropertyText(asProp({ ...r, description: undefined }))),
  titledesc: rows.map((r) => `${r.title ?? ""}. ${r.description ?? ""}`.trim()),
};

// ── embeddings (cached) ──────────────────────────────────────────────────────

type TaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
const cache: { meta: { apiCalls: number; retries: number; queryMs: number[]; docMs: number[] }; vectors: Record<string, number[]> } = existsSync(CACHE)
  ? JSON.parse(readFileSync(CACHE, "utf8"))
  : { meta: { apiCalls: 0, retries: 0, queryMs: [], docMs: [] }, vectors: {} };
const callsBefore = cache.meta.apiCalls;
let unsaved = 0, lastCall = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const saveCache = () => { mkdirSync(`${DIR}/.cache`, { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache)); unsaved = 0; };

async function embed(text: string, kind: "query" | "doc", taskType?: TaskType): Promise<number[]> {
  const key = `${MODEL}|${taskType ?? "none"}|${createHash("sha256").update(text).digest("hex")}`;
  const hit = cache.vectors[key];
  if (hit) return hit;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("an embedding is not cached and GEMINI_API_KEY is not set");
  for (let attempt = 0; ; attempt++) {
    await sleep(Math.max(0, lastCall + PACE_MS - Date.now()));
    lastCall = Date.now();
    // same body as embedSingleText in src/lib/embedder.ts, plus taskType when asked; key in a header so it never lands in a logged URL
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ model: `models/${MODEL}`, content: { parts: [{ text }] }, ...(taskType ? { taskType } : {}) }),
    });
    cache.meta.apiCalls++;
    if ((res.status === 429 || res.status === 503) && attempt < 6) {
      cache.meta.retries++;
      await sleep(5000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`embedding API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const values = ((await res.json()) as { embedding: { values: number[] } }).embedding.values;
    (kind === "query" ? cache.meta.queryMs : cache.meta.docMs).push(Date.now() - lastCall);
    cache.vectors[key] = values;
    if (++unsaved >= 20) saveCache();
    return values;
  }
}

// ── text scoring ─────────────────────────────────────────────────────────────

// Lucene's English stop set; a trailing plural "s" is stripped as a stand-in for an English stemmer.
const STOP = new Set("a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with".split(" "));
const tokens = (s: string) =>
  s.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((t) => t && !STOP.has(t)).map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));

/** BM25 of each doc against the query; document statistics come from the docs given (the candidate pool). */
function bm25(query: string[], docs: string[][]): number[] {
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return docs.map((d) => {
    let score = 0;
    for (const t of new Set(query)) {
      const f = d.filter((x) => x === t).length;
      if (!f) continue;
      const n = df.get(t)!;
      score += Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)) * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / avg)));
    }
    return score;
  });
}

const cos = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / Math.sqrt(na * nb);
};

// ── metrics ──────────────────────────────────────────────────────────────────

const dcg = (rels: number[], k: number) => rels.slice(0, k).reduce((s, r, i) => s + (2 ** r - 1) / Math.log2(i + 2), 0);
interface Score { ndcg8: number; ndcg3: number; rec8: number; mrr: number }
/** `ranked` = listing indexes, best first; the ideal order is taken over the same listings. NaN where the pool gives nothing to find. */
function score(ranked: number[], rel: number[]): Score {
  const r = ranked.map((i) => rel[i]!);
  const ideal = [...r].sort((a, b) => b - a);
  const twos = r.filter((x) => x === 2).length;
  return {
    ndcg8: dcg(r, SLOTS) / dcg(ideal, SLOTS),
    ndcg3: dcg(r, 3) / dcg(ideal, 3),
    rec8: r.slice(0, SLOTS).filter((x) => x === 2).length / Math.min(SLOTS, twos),
    mrr: twos ? 1 / (r.indexOf(2) + 1) : NaN,
  };
}
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const meanScore = (s: Score[]): Score => ({ ndcg8: mean(s.map((x) => x.ndcg8)), ndcg3: mean(s.map((x) => x.ndcg3)), rec8: mean(s.map((x) => x.rec8)), mrr: mean(s.map((x) => x.mrr)) });

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Percentile bootstrap 95% interval of the mean, resampling queries. Seeded: the same input prints the same interval. */
function bootCI(vals: number[]): [number, number] {
  const rng = mulberry32(20261126);
  const means = new Float64Array(BOOT);
  for (let b = 0; b < BOOT; b++) {
    let s = 0;
    for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rng() * vals.length)]!;
    means[b] = s / vals.length;
  }
  means.sort();
  return [means[Math.floor(0.025 * BOOT)]!, means[Math.ceil(0.975 * BOOT) - 1]!];
}
function shuffled(a: number[], rng: () => number) {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

const f3 = (x: number) => x.toFixed(3);
const signed = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
const ci = (v: number[]) => { const [lo, hi] = bootCI(v); return `[${f3(lo)}, ${f3(hi)}]`; };
const ciSigned = (v: number[]) => { const [lo, hi] = bootCI(v); return `[${signed(lo)}, ${signed(hi)}]`; };
function table(head: string[], body: string[][]) {
  const w = head.map((h, c) => Math.max(h.length, ...body.map((r) => r[c]!.length)));
  const line = (r: string[]) => `| ${r.map((x, c) => x.padEnd(w[c]!)).join(" | ")} |`;
  console.log([line(head), `|${w.map((n) => "-".repeat(n + 2)).join("|")}|`, ...body.map(line)].join("\n") + "\n");
}

// ── self-check ───────────────────────────────────────────────────────────────

assert.deepEqual(tokens("The Pools, near cafés & the Glass-house"), ["pool", "near", "café", "glass", "house"]);
assert.deepEqual(score([0, 1, 2], [2, 1, 0]), { ndcg8: 1, ndcg3: 1, rec8: 1, mrr: 1 });
assert.ok(score([2, 1, 0], [2, 1, 0]).ndcg8 < 1 && score([2, 1, 0], [2, 1, 0]).mrr === 1 / 3);
assert.equal(score([0, 1, 2, 3, 4, 5, 6, 7, 8], [0, 0, 0, 0, 0, 0, 0, 0, 2]).rec8, 0);
{
  const s = bm25(["pool"], [["pool", "villa"], ["beach", "villa"], ["pool", "pool", "villa", "garden", "garden", "garden"]]);
  assert.ok(s[0]! > 0 && s[1] === 0 && s[2]! > 0);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 19 docs x (prod text, prod text as RETRIEVAL_DOCUMENT, no description, title+description) + 40 queries x (plain, RETRIEVAL_QUERY)
  const dFull: number[][] = [], dTask: number[][] = [], dNoDesc: number[][] = [], dTitleDesc: number[][] = [];
  for (let i = 0; i < N; i++) {
    dFull.push(await embed(TEXT.full[i]!, "doc"));
    dTask.push(await embed(TEXT.full[i]!, "doc", "RETRIEVAL_DOCUMENT"));
    dNoDesc.push(await embed(TEXT.nodesc[i]!, "doc"));
    dTitleDesc.push(await embed(TEXT.titledesc[i]!, "doc"));
  }
  const qPlain: number[][] = [], qTask: number[][] = [];
  for (const q of queries) {
    qPlain.push(await embed(q.text, "query"));
    qTask.push(await embed(q.text, "query", "RETRIEVAL_QUERY"));
  }
  if (unsaved) saveCache();
  assert.ok([...dFull, ...dTask, ...dNoDesc, ...dTitleDesc, ...qPlain, ...qTask].every((v) => v.length === dFull[0]!.length), "mixed embedding sizes");

  const simOf = (qv: number[][], dv: number[][]) => qv.map((q) => dv.map((d) => cos(q, d)));
  const SIM = { plain: simOf(qPlain, dFull), task: simOf(qTask, dTask), nodesc: simOf(qPlain, dNoDesc), titledesc: simOf(qPlain, dTitleDesc) };
  const docTokens = TEXT.full.map(tokens);
  const qTokens = queries.map((q) => tokens(q.text));
  // heuristic: the query's words, plus the amenity keys it names (the pipeline's own alias table), against title/type/amenities
  const heurDoc = rows.map((r) => new Set([...tokens(`${r.title ?? ""} ${r.propertyType ?? ""} ${r.placeType ?? ""} ${(r.amenities ?? []).join(" ")}`), ...(r.amenities ?? [])]));
  const heurQuery = queries.map((q) => [...new Set<string>([...tokens(q.text), ...amenitiesNamed(q.text)])]);

  // A pool is listing indexes in backend order; every ranker breaks ties by that order.
  type Ranker = (qi: number, pool: number[]) => number[];
  const order = (pool: number[], s: (i: number) => number) =>
    pool.map((i, pos) => ({ i, pos, s: s(i) })).sort((a, b) => b.s - a.s || a.pos - b.pos).map((x) => x.i);
  const byVector = (sim: number[][]): Ranker => (qi, pool) => order(pool, (i) => sim[qi]![i]!);
  const bm25In = (qi: number, pool: number[]) => new Map(bm25(qTokens[qi]!, pool.map((i) => docTokens[i]!)).map((s, p) => [pool[p]!, s]));
  const byBm25: Ranker = (qi, pool) => { const s = bm25In(qi, pool); return order(pool, (i) => s.get(i)!); };
  const byRrf: Ranker = (qi, pool) => {
    const s = bm25In(qi, pool);
    // like $rankFusion: a stay the text search did not match adds nothing from that side
    const lists = [byVector(SIM.plain)(qi, pool), byBm25(qi, pool).filter((i) => s.get(i)! > 0)];
    const fused = new Map<number, number>();
    for (const l of lists) l.forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + r + 1)));
    return order(pool, (i) => fused.get(i) ?? 0);
  };
  const METHODS: { key: string; label: string; rank: Ranker }[] = [
    { key: "backend", label: "1 backend order (newest first)", rank: (_qi, pool) => pool },
    { key: "vector", label: "2 vector (as production embeds)", rank: byVector(SIM.plain) },
    { key: "bm25", label: "3 BM25, same text", rank: byBm25 },
    { key: "rrf", label: "4 RRF of 2 and 3 (k=60)", rank: byRrf },
    { key: "task", label: "5a vector, QUERY/DOCUMENT taskType", rank: byVector(SIM.task) },
    { key: "nodesc", label: "5b vector, text without description", rank: byVector(SIM.nodesc) },
    { key: "titledesc", label: "5c vector, title + description only", rank: byVector(SIM.titledesc) },
    { key: "heur", label: "6 keyword/amenity overlap", rank: (qi, pool) => order(pool, (i) => heurQuery[qi]!.filter((t) => heurDoc[i]!.has(t)).length) },
  ];
  assert.deepEqual(byRrf(0, ALL).length, N);

  const ms = [...cache.meta.queryMs].sort((a, b) => a - b);
  console.log(`# Ranking benchmark\n`);
  console.log(`${N} listings, ${queries.length} queries (${queries.filter((q) => q.lang === "en").length} English, ${queries.filter((q) => q.lang === "hinglish").length} Hinglish, ${queries.filter((q) => q.lang === "hi").length} Hindi; ${queries.filter((q) => q.kind === "soft").length} soft, ${queries.filter((q) => q.kind === "mixed").length} mixed), ${SLOTS} cards shown.`);
  console.log(`Grades: ${[2, 1, 0].map((g) => `${queries.reduce((s, q) => s + q.rel.filter((r) => r === g).length, 0)} x ${g}`).join(", ")}; relevance-2 listings per query: median ${[...queries.map((q) => q.rel.filter((r) => r === 2).length)].sort((a, b) => a - b)[queries.length >> 1]}.`);
  console.log(`Embeddings: ${Object.keys(cache.vectors).length} cached vectors of ${dFull[0]!.length} dims; API calls this run ${cache.meta.apiCalls - callsBefore}, in total ${cache.meta.apiCalls} (${cache.meta.retries} retried on 429/503)` +
    (ms.length ? `; a query embedding took median ${ms[ms.length >> 1]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms from this machine.` : "."));
  console.log(`Listing text: full ${Math.round(mean(TEXT.full.map((t) => t.length)))} chars on average, without description ${Math.round(mean(TEXT.nodesc.map((t) => t.length)))}, title + description ${Math.round(mean(TEXT.titledesc.map((t) => t.length)))}.\n`);

  // ── experiment 1: all 19 listings as the candidate pool ────────────────────
  const ranked: Record<string, number[][]> = {};
  const per: Record<string, Score[]> = {};
  for (const m of METHODS) {
    ranked[m.key] = queries.map((_q, qi) => m.rank(qi, ALL));
    per[m.key] = queries.map((q, qi) => score(ranked[m.key]![qi]!, q.rel));
  }
  const rng = mulberry32(19);
  const randomPer = queries.map((q) => meanScore(Array.from({ length: DRAWS }, () => score(shuffled(ALL, rng), q.rel))));

  const metricsTable = (title: string, idx: number[]) => {
    console.log(`### ${title} (n = ${idx.length})\n`);
    const row = (label: string, s: Score[]) => {
      const sub = idx.map((i) => s[i]!);
      const m = meanScore(sub);
      return [label, f3(m.ndcg8), ci(sub.map((x) => x.ndcg8)), f3(m.ndcg3), f3(m.rec8), f3(m.mrr)];
    };
    table(["method", "nDCG@8", "95% interval", "nDCG@3", "Recall@8 of 2s", "MRR of first 2"],
      [...METHODS.map((m) => row(m.label, per[m.key]!)), row(`(reference) random order, mean of ${DRAWS}`, randomPer)]);
  };
  const pairedTable = (title: string, idx: number[]) => {
    console.log(`### ${title} (n = ${idx.length})\n`);
    const versus = (m: string, base: string) => {
      if (m === base) return ["-", "-", "-"];
      const d = idx.map((i) => per[m]![i]!.ndcg8 - per[base]![i]!.ndcg8);
      const w = d.filter((x) => x > 1e-9).length, l = d.filter((x) => x < -1e-9).length;
      return [signed(mean(d)), ciSigned(d), `${w}/${d.length - w - l}/${l}`];
    };
    table(["method", "vs 1: mean diff", "95% interval", "win/tie/loss", "vs 2: mean diff", "95% interval", "win/tie/loss"],
      METHODS.map((m) => [m.label, ...versus(m.key, "backend"), ...versus(m.key, "vector")]));
  };
  const where = (f: (q: Query) => boolean) => queries.map((q, i) => (f(q) ? i : -1)).filter((i) => i >= 0);
  const everyQ = where(() => true);

  console.log(`## Experiment 1: candidate pool = all ${N} listings\n`);
  metricsTable("All queries", everyQ);
  pairedTable("Paired nDCG@8 differences, all queries", everyQ);
  console.log(`An interval that contains 0 means the difference is within the noise of these ${queries.length} queries.\n`);
  metricsTable("English queries", where((q) => q.lang === "en"));
  metricsTable("Hinglish + Hindi queries", where((q) => q.lang !== "en"));
  pairedTable("Paired nDCG@8 differences, English", where((q) => q.lang === "en"));
  pairedTable("Paired nDCG@8 differences, Hinglish + Hindi", where((q) => q.lang !== "en"));
  metricsTable("Hinglish only", where((q) => q.lang === "hinglish"));
  metricsTable("Hindi (Devanagari) only", where((q) => q.lang === "hi"));
  metricsTable("Soft-only queries", where((q) => q.kind === "soft"));
  metricsTable("Mixed queries (also name something the pipeline can filter on)", where((q) => q.kind === "mixed"));
  pairedTable("Paired nDCG@8 differences, soft-only", where((q) => q.kind === "soft"));

  console.log(`### How often the top-${SLOTS} SET differs (${SLOTS} of ${N} listings are shown whatever the method)\n`);
  const top = (m: string, qi: number) => new Set(ranked[m]![qi]!.slice(0, SLOTS));
  const setDiff = (m: string, base: string) => {
    if (m === base) return ["-", "-"];
    const changed = queries.map((_q, qi) => { const b = top(base, qi); return [...top(m, qi)].filter((i) => !b.has(i)).length; });
    return [`${changed.filter((c) => c > 0).length}/${queries.length}`, mean(changed).toFixed(2)];
  };
  table(["method", "vs 1: queries with a different set", "cards changed (mean)", "vs 2: queries with a different set", "cards changed (mean)"],
    METHODS.map((m) => [m.label, ...setDiff(m.key, "backend"), ...setDiff(m.key, "vector")]));
  const sameEverywhere = queries.filter((_q, qi) => new Set(METHODS.map((m) => [...top(m.key, qi)].sort((a, b) => a - b).join(","))).size === 1).length;
  console.log(`All ${METHODS.length} methods show the same ${SLOTS} listings (in some order) for ${sameEverywhere}/${queries.length} queries.\n`);

  if (DETAIL) {
    console.log(`### Top 3 per query (listing key:grade)\n`);
    for (const [qi, q] of queries.entries()) {
      console.log(`${q.id} [${q.lang}/${q.kind}] ${q.text}   (2s: ${KEY.filter((_, i) => q.rel[i] === 2).join(" ")})`);
      for (const m of METHODS) console.log(`   ${m.key.padEnd(10)} ${ranked[m.key]![qi]!.slice(0, 3).map((i) => `${KEY[i]}:${q.rel[i]}`).join("  ")}   nDCG@8 ${f3(per[m.key]![qi]!.ndcg8)}`);
    }
    console.log("");
  }

  // ── experiment 2: pool size ────────────────────────────────────────────────
  // Each query's candidate pool is a random subset of the catalogue. BM25 statistics are recomputed inside the pool,
  // as in-process BM25 over the fetched rows would do. A pool with nothing graded above 0 has no nDCG and is skipped.
  console.log(`## Experiment 2: pool size (${DRAWS} random pools per query and size; ${SLOTS} cards)\n`);
  const goa = ALL.filter((i) => rows[i]!.address?.state === "Goa");
  // size 0 = a fixed pool: the Goa stays, the one place filter that leaves more than 8 today
  const SIZES: { label: string; size: (draw: number) => number }[] = [
    { label: "5", size: () => 5 },
    { label: "half (9-10)", size: (d) => 9 + (d % 2) },
    { label: "14", size: () => 14 },
    { label: `all ${N}`, size: () => N },
    { label: `Goa only (${goa.length})`, size: () => 0 },
  ];
  const cell: Record<string, Record<string, { n8: number[]; n3: number[] }>> = {};
  let skipped = 0;
  for (const sz of SIZES) {
    const poolRng = mulberry32(7 + sz.label.length);
    const acc: Record<string, { n8: number[]; n3: number[] }> = Object.fromEntries([...METHODS.map((m) => m.key), "random"].map((k) => [k, { n8: [], n3: [] }]));
    for (const [qi, q] of queries.entries()) {
      const sum: Record<string, [number, number]> = Object.fromEntries(Object.keys(acc).map((k) => [k, [0, 0]]));
      let used = 0;
      const fixed = sz.size(0) === N ? ALL : sz.size(0) === 0 ? goa : null;
      for (let d = 0; d < (fixed ? 1 : DRAWS); d++) {
        const pool = fixed ?? shuffled(ALL, poolRng).slice(0, sz.size(d)).sort((a, b) => a - b);
        if (!pool.some((i) => q.rel[i]! > 0)) { skipped++; continue; }
        used++;
        for (const m of METHODS) { const s = score(m.rank(qi, pool), q.rel); sum[m.key]![0] += s.ndcg8; sum[m.key]![1] += s.ndcg3; }
        // random order: averaged over a few shuffles of the same pool
        for (let r = 0; r < 20; r++) { const s = score(shuffled(pool, poolRng), q.rel); sum.random![0] += s.ndcg8 / 20; sum.random![1] += s.ndcg3 / 20; }
      }
      assert.ok(used > 0, `${q.id}: no usable pool of size ${sz.label}`);
      for (const k of Object.keys(acc)) { acc[k]!.n8.push(sum[k]![0] / used); acc[k]!.n3.push(sum[k]![1] / used); }
    }
    cell[sz.label] = acc;
  }
  for (const [metric, pick] of [["nDCG@8", "n8"], ["nDCG@3", "n3"]] as const) {
    console.log(`### ${metric} by pool size: mean, then the paired difference from backend order with its 95% interval over queries\n`);
    table(["method", ...SIZES.map((s) => `pool ${s.label}`)],
      [...METHODS, { key: "random", label: "(reference) random order" }].map((m) => [m.label, ...SIZES.map((s) => {
        const v = cell[s.label]![m.key]![pick], b = cell[s.label]!.backend![pick];
        if (m.key === "backend") return f3(mean(v));
        const d = v.map((x, i) => x - b[i]!);
        return `${f3(mean(v))} (${signed(mean(d))} ${ciSigned(d)})`;
      })]));
  }
  console.log(`${skipped} random pools held nothing graded above 0 for their query and were skipped.`);
  console.log(`"Goa only" is not random: it is every query ranked inside the ${goa.length} Goa stays, as after a place filter (some of those queries would never be asked about Goa).`);
  console.log(`Read this as a trend inside ${N} listings only. A pool of 5 to ${N} with ${SLOTS} slots shows 42-100% of the pool; 300 listings would show under 3%. Nothing here measures that regime.`);
}

main().catch((e) => {
  if (unsaved) saveCache(); // keep what was already paid for
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
