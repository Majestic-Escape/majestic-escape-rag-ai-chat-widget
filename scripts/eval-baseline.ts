// Baseline: what the PRE-pipeline assistant would have shown for the golden
// search turns, measured with its own retrieval logic (eval/baseline/v1.ts,
// verbatim from 9959a00) over the real catalogue.
//
//   npx tsx scripts/eval-baseline.ts
//
// What is reproduced: embed the current message only → cosine over every
// listing's embedding text (the same builder the service uses) → top 12 →
// selectCards. What is NOT reproduced: the old model's wording (that model is
// retired) and production's stored embeddings (no production database access) —
// the embeddings are recomputed here with the same model and the same text.
// Each shown card is then judged against the turn's expected requirements with
// the same validator the new pipeline uses, and against the place by asking the
// site's own search which stays are in it.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { selectCards, shouldUseRag, type PropertyResult } from "../eval/baseline/v1";
import { buildPropertyText } from "../src/lib/embedder";
import { fetchCandidates } from "../src/lib/rag/catalog";
import { evaluate } from "../src/lib/rag/requirements";
import type { Listing, SearchState } from "../src/lib/rag/types";

for (const f of [".env.local", "../majestic-escape-rag-ai-chat-widget/.env.local"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  break;
}
const CATALOG = (process.env.CATALOG_API_URL ?? "https://server.majesticescape.in/api/v1").replace(/\/+$/, "");
mkdirSync("eval/.cache", { recursive: true });
const CACHE = "eval/.cache/embeddings.json";
const cache: Record<string, number[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

async function embed(text: string): Promise<number[]> {
  if (cache[text]) return cache[text]!;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      body: JSON.stringify({ model: "models/gemini-embedding-001", content: { parts: [{ text }] } }),
    });
    if (res.ok) {
      const v = ((await res.json()) as { embedding: { values: number[] } }).embedding.values;
      cache[text] = v;
      writeFileSync(CACHE, JSON.stringify(cache));
      return v;
    }
    if (attempt === 5) throw new Error(`embedding failed: ${res.status}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / Math.sqrt(na * nb);
};

type Expect = Omit<SearchState, "place"> & { place?: string | string[] };
interface Turn { u: string; state?: Expect; clarify?: boolean; out?: string[] }

async function main(): Promise<void> {
  const signal = new AbortController().signal;
  const all = await fetchCandidates({}, { baseUrl: CATALOG, fetch }, signal);
  if (all.kind !== "ok" || !all.complete) throw new Error("could not load the catalogue");
  const listings = all.rows as (Listing & { description?: string })[];
  const vectors = new Map<string, number[]>();
  for (const l of listings) vectors.set(l._id, await embed(buildPropertyText(l as never)));

  const turns: { id: string; turn: Turn; first: boolean }[] = readdirSync("eval/golden/dev")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(`eval/golden/dev/${f}`, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as { id: string; turns: Turn[] }))
    .flatMap((c) => c.turns.map((turn, i) => ({ id: `${c.id}#${i + 1}`, turn, first: i === 0 })))
    .filter((t) => t.turn.state && !t.turn.clarify && !t.turn.out && Object.keys(t.turn.state).length > 0);

  const inPlace = new Map<string, Set<string> | null>();
  let judged = 0, skippedByGate = 0, turnsWithViolation = 0, cards = 0, badRequirement = 0, badPlace = 0;
  const examples: string[] = [];
  for (const { id, turn } of turns) {
    // The old intent gate: some search messages never reached retrieval at all.
    if (!shouldUseRag(turn.u)) { skippedByGate++; continue; }
    const q = await embed(turn.u);
    const ranked: PropertyResult[] = listings
      .map((l) => ({ ...(l as unknown as PropertyResult), score: cosine(q, vectors.get(l._id)!) }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 12);
    const shown = selectCards(turn.u, ranked);
    const { place, ...requirements } = turn.state!;
    const placeText = Array.isArray(place) ? place[place.length - 1] : place;
    let allowed: Set<string> | null = null;
    if (placeText) {
      if (!inPlace.has(placeText)) {
        const r = await fetchCandidates({ place: placeText }, { baseUrl: CATALOG, fetch }, signal);
        inPlace.set(placeText, r.kind === "ok" && (r.scope === "place" || r.scope === "name") ? new Set(r.rows.map((x) => x._id)) : r.kind === "ok" ? new Set() : null);
      }
      allowed = inPlace.get(placeText) ?? null;
    }
    judged++;
    let bad = 0;
    for (const c of shown) {
      cards++;
      const l = listings.find((x) => x._id === String(c._id))!;
      const failed = evaluate(l, requirements as SearchState).filter((r) => r.status === "unsatisfied").map((r) => r.key);
      const wrongPlace = allowed !== null && !allowed.has(l._id);
      if (failed.length) badRequirement++;
      if (wrongPlace) badPlace++;
      if (failed.length || wrongPlace) {
        bad++;
        if (examples.length < 6) examples.push(`  ${id} "${turn.u.slice(0, 60)}" → showed "${l.title}" (${[...failed, ...(wrongPlace ? ["place"] : [])].join(", ")})`);
      }
    }
    if (bad) turnsWithViolation++;
  }

  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
  console.log(`\n=== BASELINE — pre-pipeline retrieval (9959a00) over ${listings.length} real listings, dev golden search turns ===`);
  console.log(`search turns: ${turns.length}   refused by the old intent gate (treated as chit-chat): ${skippedByGate}   judged: ${judged}`);
  console.log(`turns that showed at least one stay breaking a stated requirement or place: ${turnsWithViolation}/${judged} (${pct(turnsWithViolation, judged)})`);
  console.log(`cards shown: ${cards}   breaking a requirement: ${badRequirement} (${pct(badRequirement, cards)})   outside the place asked: ${badPlace} (${pct(badPlace, cards)})`);
  console.log(`note: follow-up turns are judged as the old code saw them — the current message alone, with no memory of earlier requirements.`);
  console.log(examples.join("\n"));
}

main().catch((err) => { console.error(err); process.exit(1); });
