// Plays golden conversations through the real pipeline and scores what it
// understood and what it showed.
//
//   npm run eval:rag                                  replay the default recording of the dev set (free, offline)
//   npm run eval:rag -- --live                        call the real model(s); resumes from its own recording
//   npm run eval:rag -- --live --model groq:qwen/qwen3.8-27b   benchmark ONE model, no fallback
//   npm run eval:rag -- --live --run r2               an independent repetition (its own recording)
//   npm run eval:rag -- --live --budget 60            a controlled batch: at most 60 new model calls, then stop
//   npm run eval:rag -- --set heldout --live --run r1 gate time only; prints totals, never cases
//   npm run eval:rag -- --only hg-06,mt-04            some conversations, verbose
//   npm run eval:rag -- --live --every 3 --model …    the same third of the set for every model (quota-sized benchmark)
//   npm run eval:rag -- --summary r1,r2,r3            variability across recorded repetitions (offline)
//   npm run eval:rag -- --inventory                   case inventory as Markdown
//
// Recordings are the checkpoint. Every model answer is saved the moment it
// arrives, keyed by the exact input, in eval/recordings/<set>/<chain>__<run>.json.
// A run that stops — quota, budget, Ctrl-C — continues from there with the same
// command and never repeats a completed call. Exit code 3 = incomplete, resume.
//
// Quota-aware: calls are paced for free tiers; when a provider says "rate
// limited" the runner waits as long as it asks (bounded), and after several
// provider failures in a row it stops the batch instead of burning the window.
// A turn whose model call failed is a PROVIDER ERROR: it is reported
// separately and never scored as a misunderstanding.
//
// A replay proves the code behaves the same on recorded answers; only a live
// run says anything about a model. Every report states which it was.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { evaluate } from "../src/lib/rag/requirements";
import { envKeys, newHealth, parseChain, proposeJson, providerId, routeChain, type LlmResult } from "../src/lib/rag/llm";
import { DEFAULT_CHAIN } from "../src/lib/rag/runtime";
import { handleTurn, type PipelineDeps, type TurnResult } from "../src/lib/rag/pipeline";
import { memoryStore } from "../src/lib/rag/state";
import type { Listing, SearchState } from "../src/lib/rag/types";
import { applyDelta, validateProposal } from "../src/lib/rag/understand";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] ?? d : d);
const LIVE = flag("live");
const SET = opt("set", "dev");
const RUN = opt("run", "r1");
const ONLY = args.includes("--only") ? opt("only", "").split(",") : null;
const BUDGET = Number(opt("budget", "100000"));
const EVERY = Math.max(1, Number(opt("every", "1")));
const MAX_WAIT_MS = Number(opt("max-wait", "240")) * 1000;
// --live-catalog: always ask the real search API (no cache), so turn times are end to end
const LIVE_CATALOG = flag("live-catalog");
const PRIMARY_ONLY = flag("primary-only");
const HELD_OUT = SET.startsWith("heldout");
const NOW = new Date("2026-11-25T04:30:00Z"); // 10:00 IST, Wednesday — the golden sets' "today"
const CATALOG = (process.env.CATALOG_API_URL ?? "https://server.majesticescape.in/api/v1").replace(/\/+$/, "");
const KEY = "g:g_eval-0000-0000";

// keys: .env.local of this checkout, else the canonical checkout's
for (const f of [".env.local", "../majestic-escape-rag-ai-chat-widget/.env.local"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  break;
}
const CHAIN_SPEC = opt("model", opt("chain", process.env.LLM_CHAIN ?? DEFAULT_CHAIN));
const chain = parseChain(CHAIN_SPEC, envKeys());
// --chain-hinglish: routing by language, as LLM_CHAIN_HINGLISH does in production
const CHAIN_HI_SPEC = opt("chain-hinglish", "");
const chainHi = CHAIN_HI_SPEC ? parseChain(CHAIN_HI_SPEC, envKeys()) : null;
const SPEC_KEY = CHAIN_HI_SPEC ? `${CHAIN_SPEC}|hi:${CHAIN_HI_SPEC}` : CHAIN_SPEC;
const COMPOSE = flag("compose");
const DOWN = opt("unavailable", ""); // comma-separated models treated as out of quota (--compose)
const composeRecs: Record<string, Record<string, LlmResult>> = {};
if (COMPOSE && LIVE) throw new Error("--compose is a replay of recorded answers; it cannot be combined with --live");
const TAG = SPEC_KEY.replace(/[^A-Za-z0-9.]+/g, "-");
// Free tiers: Groq allows ~8,000 tokens a minute per model (one call ≈ 1,500); Gemini a handful of calls a minute.
const PACE_MS = Number(opt("pace", chain[0]?.kind === "groq" ? "12500" : "5000"));

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = <T,>(f: string, d: T): T => (existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : d);
mkdirSync(`eval/recordings/${SET}`, { recursive: true });
mkdirSync("eval/reports", { recursive: true });
const recFile = (run: string) => `eval/recordings/${SET}/${TAG}__${run}.json`;
const CAT_FILE = "eval/recordings/catalog.json";
const catCache = readJson<Record<string, { status: number; body: unknown }>>(CAT_FILE, {});

// ── cases ───────────────────────────────────────────────────────────────────

type Expect = Omit<SearchState, "place"> & { place?: string | string[] };
interface Turn { u: string; state?: Expect; clarify?: boolean; out?: string[] }
interface Case { id: string; cat: string; lang: string; turns: Turn[] }

function loadCases(): Case[] {
  const dir = `eval/golden/${SET}`;
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()
    .flatMap((f) => readFileSync(`${dir}/${f}`, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Case));
}

// ── scoring ─────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/,?\s*india$/i, "").replace(/\s+/g, " ").trim();
const words = (s: string) => new Set(norm(s).split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length > 2));
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? [...v].map(sorted).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]))
  : v;

/** Field-by-field differences between the expected and the actual requirements. */
function diffState(want: Expect, got: SearchState): string[] {
  const out: string[] = [];
  const { place: wp, unsupported: wu = [], soft: _ws, ...wrest } = want;
  const { place: gp, unsupported: gu = [], soft: _gs, shownIds: _a, consentFor: _b, ...grest } = got;
  const places = wp === undefined ? [] : Array.isArray(wp) ? wp : [wp];
  if (places.length ? !places.some((p) => norm(p) === norm(gp ?? "")) : gp !== undefined) out.push(`place: want ${JSON.stringify(wp)} got ${JSON.stringify(gp)}`);
  for (const k of new Set([...Object.keys(wrest), ...Object.keys(grest)])) {
    const w = JSON.stringify(sorted((wrest as Record<string, unknown>)[k]));
    const g = JSON.stringify(sorted((grest as Record<string, unknown>)[k]));
    if (w !== g) out.push(`${k}: want ${w} got ${g}`);
  }
  // unsupported is free wording: same count, each expected item sharing a meaningful word
  const loose = wu.every((w) => gu.some((g) => [...words(w)].some((x) => words(g).has(x))));
  if (wu.length !== gu.length || !loose) out.push(`unsupported: want ${JSON.stringify(wu)} got ${JSON.stringify(gu)}`);
  // a soft wish must never have become a hard requirement
  for (const s of want.soft ?? []) {
    if ((got.amenitiesAll ?? []).some((a) => words(s).has(a)) || gu.some((g) => [...words(s)].some((x) => words(g).has(x)))) out.push(`soft "${s}" was made a hard requirement`);
  }
  return out;
}

/** What one turn changed, as comparable strings — so a turn can be judged on its own even after an earlier one went wrong. */
function deltaOf(prev: SearchState | Expect, next: SearchState | Expect): string {
  const clean = (s: SearchState | Expect) => {
    const { shownIds: _a, consentFor: _b, soft: _c, ...rest } = s as SearchState;
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) o[k] = JSON.stringify(sorted(k === "place" ? norm(String(Array.isArray(v) ? v[v.length - 1] : v)) : k === "unsupported" ? (v as string[]).length : v));
    return o;
  };
  const a = clean(prev), b = clean(next);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort().map((k) => `${k}=${b[k] ?? "∅"}`).join(";");
}

/** Independent re-check of what was shown: every card must really satisfy every requirement. */
function cardDefects(r: TurnResult, state: SearchState, rows: Map<string, Listing>): string[] {
  const out: string[] = [];
  for (const c of r.cards) {
    const l = rows.get(c._id);
    if (!l) { out.push(`card ${c._id} not in the catalogue`); continue; }
    const res = evaluate(l, state);
    if (res.some((x) => x.status === "unsatisfied")) out.push(`card "${c.title}" violates ${res.filter((x) => x.status === "unsatisfied").map((x) => x.key).join(",")}`);
    if (c.group === "match" && res.some((x) => x.status !== "satisfied")) out.push(`card "${c.title}" shown as a match with an unverified requirement`);
  }
  return out;
}

const SEARCH_OUTCOMES = new Set(["matches", "possible_ask", "possible_shown", "no_match", "nearby", "nearby_none", "unrecognised_place", "name_not_found", "incomplete", "need_details", "unavailable"]);
// replies that say no stay fits (with or without labelled alternatives)
const NO_STAYS = new Set(["no_match", "nearby", "nearby_none", "unrecognised_place", "name_not_found"]);
const REFUSALS = new Set(["clarify", "not_processed", "busy", "other", "which_stay"]);

type Origin = "provider" | "model" | "model-caught" | "checks" | "merge" | "routing" | "cascade" | "catalog" | "missed-clarify";
interface TurnScore {
  id: string; cat: string; lang: string; text: string;
  /** end-to-end turn time (live model + live catalogue), when measured; null otherwise */
  e2e?: number | null; attempts?: number;
  /** time in the live search API this turn; whether every model refused for quota before an answer came (production: "busy") */
  search?: number | null; quota?: number;
  /** the first model of the chain this turn was routed to */
  primary?: string;
  /** no-match accounting: "nm-ok" / "nm-wrong" = no stay met the expected requirements; "false-none" = "no stays" said although one did */
  noMatch?: "nm-ok" | "nm-wrong" | "false-none" | null;
  status: "ok" | "wrong" | "provider" | "skipped" | "unrecorded";
  origin?: Origin; problems: string[]; outcome: string; ms: number; provider: string | null;
  expectedSearch: boolean; expectedClarify: boolean; violations: number; complete: boolean | null;
}

interface RunStats { scores: TurnScore[]; liveCalls: number; quotaWaits: number; stopped: string | null }

// ── one run ─────────────────────────────────────────────────────────────────

async function playRun(run: string, live: boolean): Promise<RunStats> {
  const file = recFile(run);
  const rec = readJson<Record<string, LlmResult>>(file, {});
  const health = newHealth();
  const rows = new Map<string, Listing>();
  const stats: RunStats = { scores: [], liveCalls: 0, quotaWaits: 0, stopped: null };
  let providerFailuresInARow = 0;
  let lastCall = 0;
  let lastRaw: LlmResult | null = null;
  // per-turn bookkeeping for end-to-end timing: time spent in the runner's own waits, and whether a live call was made
  let turnWaitMs = 0;
  let turnFresh = false;
  let turnSearchMs = 0;
  let turnQuota = 0;
  const timingFile = file.replace(/\.json$/, ".timing.json");
  const timing = readJson<Record<string, { e2e: number; outcome: string; search?: number; quota?: number }>>(timingFile, {});

  const llm: PipelineDeps["llm"] = async (system, user, signal) => {
    // --compose (replay only): the answer the routed chain would get, taken from each model's own
    // single-model recording of this exact call (same request as the chain's attempt with that
    // model). --unavailable <model> skips that model, as when it is out of quota.
    if (COMPOSE) {
      const routed = routeChain(String(JSON.parse(user).message ?? ""), chain, chainHi).filter((p) => !DOWN.split(",").includes(providerId(p)));
      for (const p of routed) {
        const id = providerId(p);
        const hit = (composeRecs[id] ??= readJson<Record<string, LlmResult>>(`eval/recordings/${SET}/${id.replace(/[^A-Za-z0-9.]+/g, "-")}__${run}.json`, {}))[sha(`${id}\n${system}\n${user}`)];
        if (hit) return (lastRaw = hit);
      }
      return (lastRaw = { ok: false, why: "unconfigured", attempts: 0, errors: ["no recording"] });
    }
    const key = sha(`${SPEC_KEY}\n${system}\n${user}`);
    if (rec[key]) return (lastRaw = rec[key]!);
    if (!live) return (lastRaw = { ok: false, why: "unconfigured", attempts: 0, errors: ["no recording"] });
    if (stats.stopped) return (lastRaw = { ok: false, why: "unavailable", attempts: 0, errors: [stats.stopped] });
    if (stats.liveCalls >= BUDGET) { stats.stopped = `batch budget of ${BUDGET} calls reached`; return (lastRaw = { ok: false, why: "unavailable", attempts: 0, errors: [stats.stopped] }); }
    let waited = 0;
    for (;;) {
      const pace = Math.max(0, lastCall + PACE_MS - Date.now());
      turnWaitMs += pace;
      await sleep(pace);
      lastCall = Date.now();
      turnFresh = true;
      const routed = routeChain(String(JSON.parse(user).message ?? ""), chain, chainHi);
      const out = await proposeJson(system, user, { chain: routed, fetch, reserve: async () => true, health }, signal);
      // --primary-only: an answer from the second model because the first is cooling down (its daily quota on this
      // key) is not recorded; the batch stops (exit 3) so the key watcher can switch accounts and the turn is retried
      if (out.ok && PRIMARY_ONLY && out.provider !== providerId(routed[0]!) && (health.openUntil.get(providerId(routed[0]!)) ?? 0) > Date.now()) {
        stats.stopped = `primary model ${providerId(routed[0]!)} out of quota on this key`;
        return (lastRaw = { ok: false, why: "unavailable", attempts: out.attempts, errors: [stats.stopped] });
      }
      if (out.ok) {
        stats.liveCalls++;
        providerFailuresInARow = 0;
        rec[key] = out;
        writeFileSync(file, JSON.stringify(rec)); // checkpoint: this call is never repeated
        return (lastRaw = out);
      }
      // Rate limited: wait as long as the provider asks, within a bound, and try again.
      const wait = out.why === "unavailable" ? Math.min((out.retryAfterMs ?? 30_000) + 1000, 120_000) : 20_000;
      if (waited + wait > MAX_WAIT_MS) {
        if (++providerFailuresInARow >= 4) stats.stopped = "providers kept failing — quota window probably exhausted";
        return (lastRaw = out);
      }
      stats.quotaWaits++;
      turnQuota++;
      waited += wait;
      turnWaitMs += wait;
      await sleep(wait);
    }
  };

  let turnRows: Listing[] = [];
  const catalogFetch = (async (url: string | URL) => {
    const key = String(url).replace(CATALOG, "");
    if (LIVE_CATALOG && live) {
      const t0 = performance.now();
      const res = await fetch(url);
      if (process.env.EVAL_LOG_CATALOG) console.error(`catalog ${Math.round(performance.now() - t0)}ms ${key}`);
      const body = await res.json().catch(() => null);
      turnSearchMs += performance.now() - t0;
      for (const r of ((body as { data?: Listing[] })?.data ?? [])) if (r?._id) { rows.set(r._id, r); turnRows.push(r); }
      // filled only when missing, so existing replays keep the catalogue they were scored on
      if (!catCache[key] && res.status === 200 && !HELD_OUT) { catCache[key] = { status: res.status, body }; writeFileSync(CAT_FILE, JSON.stringify(catCache)); }
      return Response.json(body, { status: res.status });
    }
    let hit = catCache[key];
    if (!hit && (live || flag("fill-catalog"))) { // --fill-catalog: a replay may fetch a search it has not seen (read-only, no model call)
      const res = await fetch(url);
      hit = catCache[key] = { status: res.status, body: await res.json().catch(() => null) };
      writeFileSync(CAT_FILE, JSON.stringify(catCache));
    }
    if (!hit) return new Response("{}", { status: 599 });
    for (const r of ((hit.body as { data?: Listing[] })?.data ?? [])) if (r?._id) { rows.set(r._id, r); turnRows.push(r); }
    return Response.json(hit.body, { status: hit.status });
  }) as typeof fetch;

  // --every N: the same fixed slice for every model (each Nth conversation), for benchmarks that must fit a free daily quota
  const cases = loadCases().filter((c, i) => (ONLY ? ONLY.includes(c.id) : i % EVERY === 0));
  for (const c of cases) {
    const store = memoryStore();
    let clock = NOW.getTime();
    const deps: PipelineDeps = { now: () => new Date(clock), store, catalog: { baseUrl: CATALOG, fetch: catalogFetch }, llm };
    let prevActual: SearchState = {};
    let prevExpected: Expect = {};
    let broken: TurnScore["status"] | null = null;
    for (const [i, t] of c.turns.entries()) {
      const base = { id: `${c.id}#${i + 1}`, cat: c.cat, lang: c.lang, text: t.u, expectedSearch: !t.clarify && !t.out, expectedClarify: !!t.clarify };
      const expected: Expect = t.state ?? prevExpected;
      if (broken) { // an earlier turn of this conversation had no model answer: its state is unknown
        stats.scores.push({ ...base, status: broken === "unrecorded" ? "unrecorded" : "skipped", problems: [], outcome: "-", ms: 0, provider: null, violations: 0, complete: null });
        prevExpected = expected;
        continue;
      }
      clock += 20_000;
      lastRaw = null;
      turnWaitMs = 0;
      turnFresh = false;
      turnSearchMs = 0;
      turnQuota = 0;
      turnRows = [];
      const t0 = performance.now();
      const r = await handleTurn({ message: t.u, key: KEY }, deps, AbortSignal.timeout(MAX_WAIT_MS + 60_000));
      const e2e = Math.round(performance.now() - t0 - turnWaitMs);
      const raw = lastRaw as LlmResult | null;
      // measured end to end only when the catalogue was live and the model answer (if any) was a live call now
      if (LIVE_CATALOG && live && (turnFresh || raw === null) && !(raw && !raw.ok)) {
        timing[base.id] = { e2e, outcome: r.outcome, search: Math.round(turnSearchMs), quota: turnQuota };
        writeFileSync(timingFile, JSON.stringify(timing));
      }
      const got = store.docs.get(KEY)?.state ?? {};
      const score: TurnScore = { ...base, status: "ok", problems: [], outcome: r.outcome, ms: raw?.ok ? raw.ms : 0, provider: raw?.ok ? raw.provider : null, violations: 0, complete: r.log.catalog && "complete" in r.log.catalog ? r.log.catalog.complete : null };

      if (raw && !raw.ok) {
        score.status = raw.errors[0] === "no recording" ? "unrecorded" : "provider";
        score.origin = "provider";
        score.problems = raw.errors;
        broken = score.status;
        stats.scores.push(score);
        prevExpected = expected;
        if (!HELD_OUT && ONLY) console.log(`\n> ${t.u}\n[${score.status}] ${raw.errors.join("; ")}`);
        continue;
      }

      const stateDiff = diffState(expected, got);
      if (t.clarify) {
        if (r.outcome !== "clarify") score.problems.push(`expected a clarifying question, got ${r.outcome}`);
        score.problems.push(...stateDiff.map((d) => `state changed on a clarify turn — ${d}`));
      } else if (t.out) {
        if (!t.out.includes(r.outcome)) score.problems.push(`outcome: want one of ${t.out.join("|")} got ${r.outcome}`);
        score.problems.push(...stateDiff);
      } else {
        score.problems.push(...stateDiff);
        if (!SEARCH_OUTCOMES.has(r.outcome)) score.problems.push(`not treated as a search: ${r.outcome}${r.log.why ? ` (${r.log.why})` : ""}`);
      }
      const cd = cardDefects(r, got, rows);
      score.violations = cd.length;
      score.problems.push(...cd);
      score.e2e = timing[base.id]?.e2e ?? null;
      score.search = timing[base.id]?.search ?? null;
      score.quota = timing[base.id]?.quota ?? 0;
      score.attempts = raw?.ok ? raw.attempts : 0;
      const routed = routeChain(t.u, chain, chainHi)[0];
      score.primary = routed ? providerId(routed) : undefined;
      // No-match accounting, on search turns whose requirements were read right (the fetched stays then answer the expected search)
      if (!t.clarify && !t.out && stateDiff.length === 0 && r.log.catalog && "complete" in r.log.catalog && r.log.catalog.complete) {
        const statuses = turnRows.map((l) => evaluate(l, got).map((x) => x.status));
        const anyMatch = statuses.some((s) => s.every((x) => x === "satisfied"));
        const anyPossible = statuses.some((s) => !s.includes("unsatisfied") && !s.every((x) => x === "satisfied"));
        const saidNone = NO_STAYS.has(r.outcome) && !r.cards.some((c) => c.group === "match");
        score.noMatch = !anyMatch && !anyPossible ? (saidNone ? "nm-ok" : "nm-wrong") : anyMatch && r.outcome === "no_match" ? "false-none" : null;
      }

      if (score.problems.length) {
        score.status = "wrong";
        // Where did it go wrong?
        const proposal = raw?.ok ? validateProposal(raw.json) : null;
        const modelOnly = proposal && typeof proposal !== "string" ? applyDelta(prevActual, proposal) : null;
        const wantDelta = deltaOf(prevExpected, expected);
        const turnRight = deltaOf(prevActual, got) === wantDelta;
        const modelRight = modelOnly !== null && deltaOf(prevActual, modelOnly) === wantDelta;
        if (r.log.catalog && "failed" in r.log.catalog) score.origin = "catalog";
        else if (t.clarify) score.origin = "missed-clarify";
        else if (stateDiff.length === 0) score.origin = "routing"; // understood, but answered as the wrong kind of turn
        else if (turnRight) score.origin = "cascade"; // this turn was read correctly; an earlier one was not
        else if (REFUSALS.has(r.outcome)) score.origin = modelRight ? "checks" : "model-caught";
        else score.origin = modelOnly !== null && deltaOf(prevActual, modelOnly) === deltaOf(prevActual, got) ? "model" : "merge";
      }
      stats.scores.push(score);
      if (ONLY && !HELD_OUT) console.log(`\n> ${t.u}\n${r.text}\n[${r.outcome}] cards=${r.cards.length} state=${JSON.stringify(got)}\nmodel=${JSON.stringify(raw?.ok ? raw.json : raw)}\n${score.problems.length ? `PROBLEMS (${score.origin}): ${score.problems.join(" | ")}` : "ok"}`);
      prevActual = got;
      prevExpected = expected;
    }
    if (live) console.error(`[${run}] ${c.id} ${stats.scores.filter((s) => s.id.startsWith(`${c.id}#`)).map((s) => s.status[0]).join("")}  (new calls ${stats.liveCalls}, waits ${stats.quotaWaits})`);
  }
  return stats;
}

// ── reporting ───────────────────────────────────────────────────────────────

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
const quantile = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : 0);

interface Summary {
  set: string; chain: string; run: string; mode: string; turns: number; scored: number; correct: number;
  providerErrors: number; skipped: number; unrecorded: number;
  searchTurns: number; unnecessaryClarify: number; clarifyTurns: number; missedClarify: number;
  violations: number; incompleteSearches: number;
  byCat: Record<string, [number, number]>; byLang: Record<string, [number, number]>; origins: Record<string, number>;
  multiTurn: [number, number]; latency: Record<string, { n: number; p50: number; p95: number }>;
  conversations: [number, number]; failing: string[];
  providers: Record<string, number>; fallbackUsed: number; e2e: { n: number; p50: number; p95: number; max: number };
  search: { n: number; p50: number; p95: number }; quotaTurns: number;
  noMatch: [number, number]; falseNone: number;
}

function summarise(run: string, mode: string, s: RunStats): Summary {
  const scored = s.scores.filter((x) => x.status === "ok" || x.status === "wrong");
  const bump = (m: Record<string, [number, number]>, k: string, ok: boolean) => { (m[k] ??= [0, 0])[1]++; if (ok) m[k]![0]++; };
  const byCat: Summary["byCat"] = {}, byLang: Summary["byLang"] = {}, origins: Record<string, number> = {};
  const convs = new Map<string, boolean>();
  let multiOk = 0, multiN = 0;
  for (const x of scored) {
    const ok = x.status === "ok";
    bump(byCat, x.cat, ok); bump(byLang, x.lang, ok);
    if (!ok && x.origin) origins[x.origin] = (origins[x.origin] ?? 0) + 1;
    const conv = x.id.split("#")[0]!;
    convs.set(conv, (convs.get(conv) ?? true) && ok);
    if (Number(x.id.split("#")[1]) > 1) { multiN++; if (ok) multiOk++; } // a follow-up turn: state carried from earlier turns
  }
  const latency: Summary["latency"] = {};
  for (const p of new Set(scored.map((x) => x.provider).filter((p): p is string => !!p))) {
    const ms = scored.filter((x) => x.provider === p && x.ms > 0).map((x) => x.ms);
    latency[p] = { n: ms.length, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) };
  }
  const providers: Record<string, number> = {};
  for (const x of scored) if (x.provider) providers[x.provider] = (providers[x.provider] ?? 0) + 1;
  const e2es = scored.filter((x) => x.e2e != null && SEARCH_OUTCOMES.has(x.outcome)).map((x) => x.e2e!);
  const searchMs = scored.filter((x) => x.search != null && x.e2e != null && SEARCH_OUTCOMES.has(x.outcome)).map((x) => x.search!);
  const searches = scored.filter((x) => x.expectedSearch);
  const clar = scored.filter((x) => x.expectedClarify);
  return {
    set: SET, chain: SPEC_KEY, run, mode, turns: s.scores.length, scored: scored.length, correct: scored.filter((x) => x.status === "ok").length,
    providerErrors: s.scores.filter((x) => x.status === "provider").length, skipped: s.scores.filter((x) => x.status === "skipped").length,
    unrecorded: s.scores.filter((x) => x.status === "unrecorded").length,
    searchTurns: searches.length, unnecessaryClarify: searches.filter((x) => REFUSALS.has(x.outcome)).length,
    clarifyTurns: clar.length, missedClarify: clar.filter((x) => x.outcome !== "clarify").length,
    violations: scored.reduce((a, x) => a + x.violations, 0), incompleteSearches: scored.filter((x) => x.complete === false).length,
    byCat, byLang, origins, multiTurn: [multiOk, multiN], latency,
    conversations: [[...convs.values()].filter(Boolean).length, convs.size],
    failing: scored.filter((x) => x.status === "wrong").map((x) => x.id),
    providers, fallbackUsed: scored.filter((x) => (x.attempts ?? 0) > 1 || (x.provider && x.provider !== x.primary)).length,
    e2e: { n: e2es.length, p50: quantile(e2es, 0.5), p95: quantile(e2es, 0.95), max: e2es.length ? Math.max(...e2es) : 0 },
    search: { n: searchMs.length, p50: quantile(searchMs, 0.5), p95: quantile(searchMs, 0.95) },
    quotaTurns: s.scores.filter((x) => (x.quota ?? 0) > 0).length,
    noMatch: [scored.filter((x) => x.noMatch === "nm-ok").length, scored.filter((x) => x.noMatch === "nm-ok" || x.noMatch === "nm-wrong").length],
    falseNone: scored.filter((x) => x.noMatch === "false-none").length,
  };
}

function printSummary(m: Summary, s: RunStats): void {
  console.log(`\n=== search assistant evaluation — set "${m.set}" — ${m.mode} — chain ${m.chain} — run ${m.run} ===`);
  console.log(`turns ${m.turns}: scored ${m.scored}, provider errors ${m.providerErrors} (+${m.skipped} later turns not run), no recording ${m.unrecorded}`);
  console.log(`TASK COMPLETION (turn fully correct): ${m.correct}/${m.scored} (${pct(m.correct, m.scored)})   conversations fully correct: ${m.conversations[0]}/${m.conversations[1]} (${pct(...m.conversations)})`);
  console.log(`multi-turn (follow-up turns): ${m.multiTurn[0]}/${m.multiTurn[1]} (${pct(...m.multiTurn)})`);
  console.log(`unnecessary clarification or refusal on a search turn: ${m.unnecessaryClarify}/${m.searchTurns} (${pct(m.unnecessaryClarify, m.searchTurns)})   missed clarification: ${m.missedClarify}/${m.clarifyTurns}`);
  console.log(`mandatory-requirement violations in shown cards: ${m.violations}   searches with an incomplete candidate set: ${m.incompleteSearches}`);
  console.log(`by category: ${Object.entries(m.byCat).map(([k, [a, b]]) => `${k} ${a}/${b}`).join("  ")}`);
  console.log(`by language: ${Object.entries(m.byLang).map(([k, [a, b]]) => `${k} ${a}/${b} (${pct(a, b)})`).join("  ")}`);
  console.log(`where wrong turns went wrong: ${Object.entries(m.origins).map(([k, v]) => `${k} ${v}`).join("  ") || "none"}`);
  console.log(`   model = wrong reading accepted · model-caught = wrong reading, refused by a check · checks = right reading refused · merge = code changed a right reading · cascade = right turn after an earlier wrong one · routing = understood, answered as the wrong kind of turn`);
  console.log(`no-match accuracy: ${m.noMatch[0]}/${m.noMatch[1]} (${pct(...m.noMatch)})   "no stays" said although a stay met every requirement: ${m.falseNone}`);
  console.log(`answered by: ${Object.entries(m.providers).map(([k, v]) => `${k} ${v}`).join("  ") || "-"}   fallback used: ${m.fallbackUsed}   provider failures (no answer): ${m.providerErrors}`);
  console.log(`end-to-end search turns (live model + live catalogue): ${m.e2e.n ? `n=${m.e2e.n} p50=${m.e2e.p50}ms p95=${m.e2e.p95}ms max=${m.e2e.max}ms` : "not measured (needs --live --live-catalog)"}${m.search.n ? `   of which in the search API: p50=${m.search.p50}ms p95=${m.search.p95}ms (n=${m.search.n})` : ""}`);
  console.log(`turns where every model first refused for quota (production would have answered "busy"): ${m.quotaTurns}   never answered within the wait (unanswered): ${m.providerErrors}`);
  console.log(`model latency: ${Object.entries(m.latency).map(([k, v]) => `${k} n=${v.n} p50=${v.p50}ms p95=${v.p95}ms`).join("  ") || "–"}`);
  if (LIVE) console.log(`new model calls this batch: ${s.liveCalls}   quota waits: ${s.quotaWaits}${s.stopped ? `   STOPPED: ${s.stopped}` : ""}`);
  if (m.providerErrors + m.unrecorded) console.log(`INCOMPLETE: ${m.providerErrors + m.unrecorded + m.skipped} turns have no model answer yet — run the same command again to resume.`);
}

async function main(): Promise<void> {
  if (flag("inventory")) return inventory();

  if (args.includes("--summary")) {
    const runs = opt("summary", "r1").split(",");
    const all: Summary[] = [];
    for (const run of runs) all.push(summarise(run, "REPLAY", await playRun(run, false)));
    console.log(`\n=== variability across ${runs.length} recorded live repetitions — set "${SET}" — chain ${CHAIN_SPEC} ===`);
    const row = (label: string, f: (m: Summary) => [number, number]) => {
      const v = all.map((m) => { const [a, b] = f(m); return b ? (100 * a) / b : NaN; });
      console.log(`${label.padEnd(34)} ${all.map((m, i) => `${m.run} ${Number.isNaN(v[i]!) ? "–" : v[i]!.toFixed(1) + "%"} (${f(m).join("/")})`).join("   ")}   range ${(Math.max(...v) - Math.min(...v)).toFixed(1)} pts`);
    };
    row("task completion", (m) => [m.correct, m.scored]);
    row("multi-turn follow-ups", (m) => m.multiTurn);
    row("unnecessary clarification", (m) => [m.unnecessaryClarify, m.searchTurns]);
    for (const cat of Object.keys(all[0]!.byCat)) row(`  category ${cat}`, (m) => m.byCat[cat] ?? [0, 0]);
    for (const lang of Object.keys(all[0]!.byLang)) row(`  language ${lang}`, (m) => m.byLang[lang] ?? [0, 0]);
    console.log(`requirement violations: ${all.map((m) => m.violations).join(" / ")}   provider errors: ${all.map((m) => m.providerErrors).join(" / ")}   unrecorded: ${all.map((m) => m.unrecorded + m.skipped).join(" / ")}`);
    const count = new Map<string, number>();
    for (const m of all) for (const id of m.failing) count.set(id, (count.get(id) ?? 0) + 1);
    const unstable = [...count].filter(([, n]) => n < all.length);
    console.log(`turns wrong in every run: ${[...count].filter(([, n]) => n === all.length).length}   wrong in some runs only (model variability): ${unstable.length}${HELD_OUT ? "" : `  ${unstable.map(([k, n]) => `${k}×${n}`).join(" ")}`}`);
    writeFileSync(`eval/reports/${SET}-${TAG}-summary.json`, JSON.stringify(all.map((m) => (HELD_OUT ? { ...m, failing: m.failing.length } : m)), null, 1));
    return;
  }

  if (LIVE && chain.length === 0) throw new Error(`no usable model in "${CHAIN_SPEC}" (missing key?)`);
  const stats = await playRun(RUN, LIVE);
  const m = summarise(RUN, LIVE ? "LIVE" : "REPLAY of recorded answers (not evidence about the model)", stats);
  printSummary(m, stats);
  // --turn-list: one line per scored turn, for matched comparisons (scripts/compare-models.ts). Dev only.
  if (flag("turn-list") && !HELD_OUT) for (const s of stats.scores) console.log(`TURN ${s.id} ${s.status} ${s.outcome} ${s.expectedClarify ? "clarify" : s.expectedSearch ? "search" : "other"} ${s.ms || 0}`);
  // The held-out set is reported in totals only: its cases must not steer development.
  if (!HELD_OUT) {
    const wrong = stats.scores.filter((x) => x.status === "wrong");
    if (wrong.length) console.log(`\nwrong turns:\n${wrong.map((x) => `  ${x.id} [${x.cat}/${x.lang}] (${x.origin}) "${x.text.slice(0, 70)}"\n      ${x.problems.join("\n      ")}`).join("\n")}`);
  }
  writeFileSync(`eval/reports/${SET}-${TAG}-${RUN}.json`, JSON.stringify(HELD_OUT ? { ...m, failing: m.failing.length } : { ...m, wrong: stats.scores.filter((x) => x.status === "wrong").map(({ id, origin, problems, lang, cat, text, primary, provider, outcome }) => ({ id, origin, problems, lang, cat, text, primary, provider, outcome })), unanswered: stats.scores.filter((x) => x.status !== "ok" && x.status !== "wrong").map(({ id, status }) => ({ id, status })) }, null, 1));
  const incomplete = m.providerErrors + m.unrecorded > 0;
  process.exit(incomplete ? 3 : m.correct === m.scored && m.violations === 0 ? 0 : 1);
}

/** Case inventory. Held-out sets list ids and categories only — never the questions. */
function inventory(): void {
  const cases = loadCases();
  const turns = cases.reduce((a, c) => a + c.turns.length, 0);
  const count = (f: (c: Case) => string) => Object.entries(cases.reduce<Record<string, number>>((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(", ");
  const lines = [`# Evaluation inventory — set \`${SET}\``, "", `${cases.length} conversations, ${turns} turns. By category: ${count((c) => c.cat)}. By language: ${count((c) => c.lang)}.`, `Clarify turns: ${cases.flatMap((c) => c.turns).filter((t) => t.clarify).length}. Non-search turns (\`out\`): ${cases.flatMap((c) => c.turns).filter((t) => t.out).length}.`, ""];
  lines.push(
    "## Scoring criteria",
    "",
    "- **Search turn**: correct when the complete requirement state after the turn equals the expected state (README conventions: `unsupported` matched loosely, `soft` only checked for not becoming a hard requirement) and the outcome is a search outcome.",
    "- **Clarify turn**: correct when the reply is a clarifying question and the state is unchanged.",
    "- **Non-search turn** (`out`): correct when the outcome is one of the listed outcomes and the state is as expected.",
    "- **Every shown card** is re-checked against the expected requirements: a card that breaks one is a mandatory-requirement violation (gate: 0), counted separately from turn accuracy.",
    "- Provider errors (quota, timeouts) are reported separately and are not scored as wrong answers.",
    ""
  );
  if (HELD_OUT) {
    lines.push("Questions and expected answers are deliberately not listed: this set is held out.", "", "| id | category | language | turns | clarify turns | non-search turns |", "|---|---|---|---:|---:|---:|");
    for (const c of cases) lines.push(`| ${c.id} | ${c.cat} | ${c.lang} | ${c.turns.length} | ${c.turns.filter((t) => t.clarify).length} | ${c.turns.filter((t) => t.out).length} |`);
  } else {
    lines.push("| id | category | language | turn | customer says | expected |", "|---|---|---|---:|---|---|");
    for (const c of cases) c.turns.forEach((t, i) => lines.push(`| ${c.id} | ${c.cat} | ${c.lang} | ${i + 1} | ${t.u.replace(/\|/g, "\\|")} | ${t.clarify ? "**clarifying question**; requirements unchanged" : t.out ? `outcome ${t.out.join(" / ")}${t.state ? `; requirements \`${JSON.stringify(t.state)}\`` : "; requirements unchanged"}` : `search; requirements \`${JSON.stringify(t.state)}\``} |`));
  }
  writeFileSync(`eval/reports/inventory-${SET}.md`, lines.join("\n") + "\n");
  console.log(`wrote eval/reports/inventory-${SET}.md — ${cases.length} conversations, ${turns} turns`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
