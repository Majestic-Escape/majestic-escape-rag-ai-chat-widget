// Paired development comparison of two models on IDENTICAL dev case ids and the
// same scoring code, from their recorded live answers replayed on the current code
// (no model calls). Every turn is accounted for: answered by both, missing for one
// (no recorded answer: quota, or an input that changed with the code), refused or
// clarified.
//
//   npx tsx scripts/compare-models.ts --run hg1 --a groq:openai/gpt-oss-120b --b groq:qwen/qwen3.8-27b --only <ids>
//   npx tsx scripts/compare-models.ts --run b3 --a … --b …            (the --every 3 slice)
//
// Dev set only (the runner refuses to list turns of a held-out set).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n: string, d = "") => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] ?? d : d);
const RUN = opt("run", "b3");
const A = opt("a"), B = opt("b");
const ONLY = opt("only");
if (!A || !B) throw new Error("--a and --b are required");
const tag = (m: string) => m.replace(/[^A-Za-z0-9.]+/g, "-");
const REFUSED = new Set(["clarify", "not_processed", "busy", "other", "which_stay"]);

interface Turn { status: string; outcome: string; kind: "search" | "clarify" | "other"; ms: number }
interface Wrong { id: string; origin: string; problems: string[] }

function run(model: string): { turns: Map<string, Turn>; wrong: Wrong[] } {
  const sel = ONLY ? ["--only", ONLY] : ["--every", "3"];
  let text = "";
  try { text = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/eval-rag.ts", "--run", RUN, "--model", model, ...sel, "--turn-list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) { text = String((e as { stdout?: string }).stdout ?? ""); }
  const turns = new Map<string, Turn>();
  for (const line of text.split("\n")) {
    const m = line.match(/^TURN (\S+) (\S+) (\S+) (\S+) (\d+)$/);
    if (m) turns.set(m[1]!, { status: m[2]!, outcome: m[3]!, kind: m[4] as Turn["kind"], ms: Number(m[5]) });
  }
  const rep = JSON.parse(readFileSync(`eval/reports/dev-${tag(model)}-${RUN}.json`, "utf8")) as { wrong: Wrong[] };
  return { turns, wrong: rep.wrong };
}

const kindOf = (p: string): string => {
  if (/^not treated as a search/.test(p)) return "refused";
  if (/^outcome:/.test(p)) return "wrong kind of reply";
  if (/was made a hard requirement/.test(p)) return "nice-to-have made a must-have";
  if (/^expected a clarifying question/.test(p)) return "missed clarification";
  const m = p.match(/^(\w+): want (.+) got (.+)$/);
  if (!m) return "other";
  return m[3] === "undefined" ? `lost ${m[1]}` : m[2] === "undefined" ? `invented ${m[1]}` : `changed ${m[1]}`;
};
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : 0);

const R = { [A]: run(A), [B]: run(B) };
const ids = [...new Set([...R[A]!.turns.keys(), ...R[B]!.turns.keys()])];
const answered = (m: string, id: string) => ["ok", "wrong"].includes(R[m]!.turns.get(id)?.status ?? "");
const both = ids.filter((id) => answered(A, id) && answered(B, id));
console.log(`case turns: ${ids.length}   answered by both: ${both.length}   missing for ${A}: ${ids.filter((i) => !answered(A, i)).length}   missing for ${B}: ${ids.filter((i) => !answered(B, i)).length}`);
const lang = (id: string) => id; void lang;

for (const m of [A, B]) {
  const t = R[m]!.turns;
  const ok = (id: string) => t.get(id)!.status === "ok";
  const fu = both.filter((id) => Number(id.split("#")[1]) > 1);
  const searches = both.filter((id) => t.get(id)!.kind === "search");
  const clar = both.filter((id) => t.get(id)!.kind === "clarify");
  const ms = both.map((id) => t.get(id)!.ms).filter((x) => x > 0);
  console.log(`\n${m}`);
  console.log(`  turns correct (answered by both): ${both.filter(ok).length}/${both.length} (${pct(both.filter(ok).length, both.length)})   strict, missing counted wrong: ${ids.filter((id) => t.get(id)?.status === "ok").length}/${ids.length} (${pct(ids.filter((id) => t.get(id)?.status === "ok").length, ids.length)})`);
  console.log(`  follow-ups correct: ${fu.filter(ok).length}/${fu.length} (${pct(fu.filter(ok).length, fu.length)})`);
  console.log(`  search turns refused or answered with a question: ${searches.filter((id) => REFUSED.has(t.get(id)!.outcome)).length}/${searches.length}   clarify turns answered with a question: ${clar.filter((id) => t.get(id)!.outcome === "clarify").length}/${clar.length}`);
  console.log(`  model latency on these turns: p50 ${q(ms, 0.5)} ms, p95 ${q(ms, 0.95)} ms (n=${ms.length}; turns read without a model have none)`);
  const firstWrong = new Map<string, Wrong>();
  for (const w of R[m]!.wrong) if (both.includes(w.id)) { const c = w.id.split("#")[0]!; if (!firstWrong.has(c)) firstWrong.set(c, w); }
  const fw = [...firstWrong.values()].filter((w) => Number(w.id.split("#")[1]) > 1);
  const causes: Record<string, number> = {};
  for (const w of fw) for (const k of new Set(w.problems.map(kindOf))) causes[k] = (causes[k] ?? 0) + 1;
  console.log(`  conversations whose first error is a follow-up: ${fw.length}   what happened: ${Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  for (const w of fw) console.log(`    ${w.id} (${w.origin}) ${w.problems.join(" | ").slice(0, 150)}`);
}
// language split on turns answered by both
const caseLang = new Map<string, string>();
for (const f of ["eval/golden/dev/cases.jsonl", "eval/golden/dev/cases-2.jsonl"]) for (const l of readFileSync(f, "utf8").split(/\r?\n/)) if (l.trim()) { const c = JSON.parse(l); caseLang.set(c.id, c.lang); }
console.log("\nby language (turns answered by both):");
for (const lg of ["en", "hinglish", "hi"]) {
  const sub = both.filter((id) => caseLang.get(id.split("#")[0]!) === lg);
  if (!sub.length) continue;
  console.log(`  ${lg.padEnd(9)} ${[A, B].map((m) => `${m.split("/").pop()} ${sub.filter((id) => R[m]!.turns.get(id)!.status === "ok").length}/${sub.length}`).join("   ")}`);
}
