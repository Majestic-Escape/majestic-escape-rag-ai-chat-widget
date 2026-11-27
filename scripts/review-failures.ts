// First wrong turn of every failed conversation in an eval report, with a suggested cause bucket.
// Dev / regression sets only (held-out reports carry no case ids).
//
//   npx tsx scripts/review-failures.ts --set reg-h4 eval/reports/reg-h4-<chain>-r1.json [more reports of the same set]
//
// Buckets: interpretation (the model read the new message wrong), language-routing (a Hindi / Hinglish
// message went to the English chain or the reverse), state (a requirement the turn did not mention was
// lost or changed: carry-forward), validation (our checks refused a right reading or missed a clarify),
// retrieval (the catalogue failed). Provider errors and skipped turns are counted apart, never as wrong.
import { readFileSync, readdirSync } from "node:fs";

const args = process.argv.slice(2);
const set = args[args.indexOf("--set") + 1]!;
if (!set || set.startsWith("heldout")) throw new Error("--set <dev or regression set> required; held-out sets are never reviewed");
const reports = args.filter((a, i) => a.endsWith(".json") && args[i - 1] !== "--set");

interface Turn { u: string; state?: Record<string, unknown>; clarify?: boolean; out?: string[] }
interface Case { id: string; cat: string; lang: string; turns: Turn[] }
interface Wrong { id: string; origin: string; problems: string[]; lang: string; cat: string; text: string; primary?: string; provider?: string | null; outcome: string }
const dir = `eval/golden/${set}`;
const cases = new Map<string, Case>(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(`${dir}/${f}`, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Case))
  .map((c) => [c.id, c]));

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** expected state after turn n (1-based): the last turn up to n that states one */
const expectedAt = (c: Case, n: number) => { let s: Record<string, unknown> = {}; for (let i = 0; i < n; i++) s = c.turns[i]!.state ?? s; return s; };
const EN_PRIMARY = "groq:openai/gpt-oss-120b", HI_PRIMARY = "groq:qwen/qwen3.8-27b";

function bucket(w: Wrong, c: Case, n: number): string {
  if (w.origin === "catalog") return "retrieval";
  if (w.origin === "checks" || w.origin === "missed-clarify") return "validation";
  if (w.origin === "merge") return "state";
  if (w.origin === "routing") return "interpretation";
  const hi = w.lang !== "en";
  if (w.primary && ((hi && w.primary === EN_PRIMARY) || (!hi && w.primary === HI_PRIMARY))) return "language-routing";
  if (n > 1) {
    const prev = expectedAt(c, n - 1), want = expectedAt(c, n);
    const fields = w.problems.map((p) => p.match(/^(?:state changed on a clarify turn — )?(\w+):/)?.[1]).filter((f): f is string => !!f);
    if (fields.some((f) => prev[f] !== undefined && same(prev[f], want[f]))) return "state";
  }
  return "interpretation";
}

for (const file of reports) {
  const rep = JSON.parse(readFileSync(file, "utf8")) as { run: string; chain: string; wrong: Wrong[]; unanswered?: { id: string; status: string }[] };
  const firsts = new Map<string, { w: Wrong; n: number }>();
  for (const w of rep.wrong) {
    const [conv, t] = w.id.split("#"); const n = Number(t);
    const cur = firsts.get(conv!);
    if (!cur || n < cur.n) firsts.set(conv!, { w, n });
  }
  const un = rep.unanswered ?? [];
  const counts: Record<string, number> = {};
  const rows: string[] = [];
  for (const [conv, { w, n }] of [...firsts].sort()) {
    const c = cases.get(conv)!;
    const b = bucket(w, c, n);
    counts[b] = (counts[b] ?? 0) + 1;
    rows.push(`| ${w.id} | ${w.lang} | ${w.cat} | ${b} | ${w.origin} | ${w.provider ?? "-"} | ${n > 1 ? c.turns[n - 2]!.u.replace(/\|/g, "/") + " → " : ""}**${w.text.replace(/\|/g, "/")}** | ${w.problems.join("; ").replace(/\|/g, "/").slice(0, 260)} |`);
  }
  console.log(`\n## ${set} ${rep.run} (${rep.chain})\n`);
  console.log(`wrong turns ${rep.wrong.length}, failed conversations ${firsts.size}; unanswered (not scored): provider ${un.filter((u) => u.status === "provider").length}, skipped ${un.filter((u) => u.status === "skipped").length}, no recording ${un.filter((u) => u.status === "unrecorded").length}`);
  console.log(`first wrong turn by cause: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}\n`);
  console.log("| first wrong turn | lang | cat | cause | origin | answered by | previous → this message | what was wrong |\n|---|---|---|---|---|---|---|---|");
  console.log(rows.join("\n"));
}
