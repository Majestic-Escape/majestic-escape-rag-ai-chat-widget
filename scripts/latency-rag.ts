// End-to-end latency of ordinary search turns: the real pipeline, the live
// production search API and the live model chain, under the route's 9-second
// deadline. Paced for free tiers; nothing is recorded or scored for accuracy.
//
//   npx tsx scripts/latency-rag.ts            # 30 first turns from the dev set
//   npx tsx scripts/latency-rag.ts --n 40 --pace 12500
//
// Only dev cases are used (never a held-out set). A turn the provider refused
// (quota, outage) is a provider error, reported apart from the timings.

import { existsSync, readFileSync } from "node:fs";
import { handleTurn, type PipelineDeps } from "../src/lib/rag/pipeline";
import { memoryStore } from "../src/lib/rag/state";
import { envKeys, newHealth, parseChain, proposeJson } from "../src/lib/rag/llm";
import { DEFAULT_CHAIN } from "../src/lib/rag/runtime";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] ?? d : d);
const N = Number(opt("n", "30"));
const PACE_MS = Number(opt("pace", "12500"));

for (const f of [".env.local", "../majestic-escape-rag-ai-chat-widget/.env.local"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  break;
}
const CATALOG = (process.env.CATALOG_API_URL ?? "https://server.majesticescape.in/api/v1").replace(/\/+$/, "");
const SPEC = opt("chain", process.env.LLM_CHAIN ?? DEFAULT_CHAIN);
const chain = parseChain(SPEC, envKeys());
const health = newHealth();

interface Turn { u: string; state?: unknown; clarify?: boolean; out?: string[] }
const firsts: string[] = [];
for (const file of ["eval/golden/dev/cases.jsonl", "eval/golden/dev/cases-2.jsonl"]) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const t = (JSON.parse(line) as { turns: Turn[] }).turns[0]!;
    if (t.state && !t.clarify && !t.out) firsts.push(t.u);
  }
}
const step = Math.max(1, Math.floor(firsts.length / N));
const messages = firsts.filter((_, i) => i % step === 0).slice(0, N);

const SEARCH = new Set(["matches", "possible_ask", "possible_shown", "nearby", "no_match", "incomplete", "name_not_found", "unrecognised_place"]);
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! : 0; };

async function main() {
  const withModel: number[] = [], noModel: number[] = [], other: string[] = [];
  let providerErrors = 0;
  for (const [i, message] of messages.entries()) {
    const deps: PipelineDeps = {
      now: () => new Date(),
      store: memoryStore(),
      catalog: { baseUrl: CATALOG, fetch },
      llm: (system, user, signal) => proposeJson(system, user, { chain, fetch, reserve: async () => true, health }, signal),
    };
    const t0 = performance.now();
    const r = await handleTurn({ message, key: `g:g_latency-${i}` }, deps, AbortSignal.timeout(9_000));
    const ms = Math.round(performance.now() - t0);
    if (r.outcome === "busy" || r.outcome === "not_processed") providerErrors++;
    else if (SEARCH.has(r.outcome)) (r.log.llm.provider ? withModel : noModel).push(ms);
    else other.push(r.outcome);
    process.stderr.write(`\r${i + 1}/${messages.length} ${r.outcome} ${ms}ms   `);
    if (providerErrors >= 3) { process.stderr.write("\nstopping: 3 provider errors\n"); break; }
    if (r.log.llm.provider) await new Promise((res) => setTimeout(res, PACE_MS));
  }
  const all = [...withModel, ...noModel];
  console.log(`\nend-to-end search turns (chain ${SPEC}, live catalogue ${CATALOG}):`);
  console.log(`  all            n=${all.length} p50=${q(all, 0.5)}ms p95=${q(all, 0.95)}ms max=${Math.max(0, ...all)}ms`);
  console.log(`  with a model   n=${withModel.length} p50=${q(withModel, 0.5)}ms p95=${q(withModel, 0.95)}ms`);
  console.log(`  no model call  n=${noModel.length} p50=${q(noModel, 0.5)}ms p95=${q(noModel, 0.95)}ms`);
  console.log(`  not a search outcome: ${other.length} (${[...new Set(other)].join(", ") || "-"})   provider errors: ${providerErrors}`);
}
main();
