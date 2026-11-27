// How much of the development set can be read WITHOUT a model, and is that
// reading ever wrong?  (src/lib/rag/quick.ts)
//
//   npx tsx scripts/eval-quick.ts            uses recorded place lookups; add --live to look up new ones
//
// Each turn is judged on its own: the state before it is the EXPECTED one, so a
// mistake in one turn cannot hide or cause another. A turn the reader declines
// is not a failure — it goes to the model. A turn it reads WRONG is.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fetchCandidates } from "../src/lib/rag/catalog";
import { applyGuards } from "../src/lib/rag/guards";
import { quickRead } from "../src/lib/rag/quick";
import type { SearchState } from "../src/lib/rag/types";
import { applyDelta, crossCheck, normaliseExact, stripRestated } from "../src/lib/rag/understand";

const LIVE = process.argv.includes("--live");
const CATALOG = "https://server.majesticescape.in/api/v1";
const CAT_FILE = "eval/recordings/catalog.json";
const cache: Record<string, { status: number; body: unknown }> = existsSync(CAT_FILE) ? JSON.parse(readFileSync(CAT_FILE, "utf8")) : {};
const TODAY = "2026-11-25";

const fetchCached = (async (url: string | URL) => {
  const key = String(url).replace(CATALOG, "");
  if (!cache[key] && LIVE) {
    const res = await fetch(url);
    cache[key] = { status: res.status, body: await res.json().catch(() => null) };
    writeFileSync(CAT_FILE, JSON.stringify(cache));
  }
  const hit = cache[key];
  return hit ? Response.json(hit.body, { status: hit.status }) : new Response("{}", { status: 599 });
}) as typeof fetch;

const isPlace = async (phrase: string) => {
  const r = await fetchCandidates({ place: phrase }, { baseUrl: CATALOG, fetch: fetchCached }, new AbortController().signal);
  const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z]/g, "") === b.toLowerCase().replace(/[^a-z]/g, "");
  return r.kind === "ok" && (r.scope === "place" || r.scope === "nearby") && !r.corrected && !!r.placeName && same(r.placeName, phrase);
};

type Expect = Omit<SearchState, "place"> & { place?: string | string[] };
interface Turn { u: string; state?: Expect; clarify?: boolean; out?: string[] }

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : Array.isArray(x) ? [...x].sort() : x));
const strip = (s: Expect | SearchState) => {
  const { soft: _s, shownIds: _a, consentFor: _c, ...rest } = s as SearchState;
  return { ...rest, place: Array.isArray((s as Expect).place) ? ((s as Expect).place as string[]).at(-1) : (s as SearchState).place };
};

async function main(): Promise<void> {
  const cases = readdirSync("eval/golden/dev").filter((f) => f.endsWith(".jsonl")).sort()
    .flatMap((f) => readFileSync(`eval/golden/dev/${f}`, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as { id: string; lang: string; turns: Turn[] }));
  let turns = 0, handled = 0, right = 0, searchTurns = 0;
  const wrong: string[] = [];
  const byLang: Record<string, [number, number]> = {};
  for (const c of cases) {
    let prev: Expect = {};
    for (const [i, t] of c.turns.entries()) {
      turns++;
      const expected = t.state ?? prev;
      const isSearch = !t.clarify && !t.out;
      if (isSearch) { searchTurns++; (byLang[c.lang] ??= [0, 0])[1]++; }
      const before = strip(prev) as SearchState;
      const q = await quickRead(t.u, isPlace);
      const p = q ? stripRestated(normaliseExact(t.u, applyGuards(t.u, q, before, TODAY)), before) : null;
      if (p && !crossCheck(t.u, p, TODAY, before)) {
        handled++;
        const got = applyDelta(before, p);
        const ok = isSearch && canon(strip(got)) === canon(strip(expected));
        if (ok) { right++; byLang[c.lang]![0]++; }
        else wrong.push(`  ${c.id}#${i + 1} "${t.u}"\n      read as ${canon(strip(got))}\n      expected ${t.clarify ? "a clarifying question" : t.out ? `outcome ${t.out.join("/")}` : canon(strip(expected))}`);
      }
      prev = expected;
    }
  }
  console.log(`\n=== reading without a model — development set (${cases.length} conversations, ${turns} turns, ${searchTurns} search turns) ===`);
  console.log(`handled without a model: ${handled}/${turns} turns (${((100 * handled) / turns).toFixed(1)}%)   of those, correct: ${right}/${handled}`);
  console.log(`search turns handled correctly, by language: ${Object.entries(byLang).map(([k, [a, b]]) => `${k} ${a}/${b}`).join("  ")}`);
  console.log(wrong.length ? `\nWRONG READINGS (each one is a defect — the reader must decline instead):\n${wrong.join("\n")}` : "no wrong readings");
  process.exit(wrong.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
