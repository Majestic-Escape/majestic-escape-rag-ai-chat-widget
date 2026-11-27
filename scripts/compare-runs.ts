// Old vs new on the same conversations: accuracy, unnecessary clarifications and carried-over mistakes,
// per group of conversations. Reads the JSON reports eval-rag writes (never a held-out set: it needs case ids).
//
//   npx tsx scripts/compare-runs.ts --set dev-fresh --groups dev-fresh A=path/to/old.json B=path/to/new.json
import { readFileSync, readdirSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n: string, d = "") => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] ?? d : d);
const SET = opt("set", "dev-fresh");
if (SET.startsWith("heldout")) throw new Error("held-out sets are reported in totals only");
const runs = args.filter((a) => /^[A-Za-z0-9_-]+=/.test(a)).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] as const);

interface Turn { u: string; clarify?: boolean; out?: string[] }
interface Case { id: string; cat: string; lang: string; turns: Turn[] }
const cases: Case[] = readdirSync(`eval/golden/${SET}`).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(`eval/golden/${SET}/${f}`, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Case));

// Groups of conversations. dev-fresh was commissioned by id range (see eval/README.md); other sets group by category.
const num = (id: string) => Number(id.replace(/\D+/g, ""));
const groupOf = (c: Case): string[] => {
  const g: string[] = [];
  if (SET === "dev-fresh") {
    const n = num(c.id);
    g.push(n <= 20 ? "mixed-language follow-ups" : n <= 30 ? "explicit removals / replacements" : n <= 38 ? "fresh search mid-chat" : n <= 42 ? "place-only change" : n <= 52 ? "long conversations" : "other turn kinds");
  } else g.push(`cat ${c.cat}`);
  if (c.lang !== "en") g.push("all Hindi / Hinglish");
  if (c.turns.length > 1) g.push("all multi-turn (follow-up turns)");
  return g;
};

type Wrong = { id: string; origin?: string; outcome: string; problems: string[] };
const load = (file: string) => {
  const j = JSON.parse(readFileSync(file, "utf8")) as { wrong: Wrong[]; unanswered: { id: string; status: string }[] };
  return { wrong: new Map(j.wrong.map((w) => [w.id, w])), unanswered: new Set(j.unanswered.map((u) => u.id)) };
};
const data = runs.map(([name, file]) => [name, load(file)] as const);

const rows = new Map<string, { turns: string[] }>();
for (const c of cases) {
  for (const [i, t] of c.turns.entries()) {
    const id = `${c.id}#${i + 1}`;
    for (const g of groupOf(c)) {
      // "follow-up turns" = turns after the first
      if (g.startsWith("all multi-turn") && i === 0) continue;
      (rows.get(g) ?? rows.set(g, { turns: [] }).get(g)!).turns.push(id);
    }
    (rows.get("ALL") ?? rows.set("ALL", { turns: [] }).get("ALL")!).turns.push(id);
  }
}
const expectClarify = new Set(cases.flatMap((c) => c.turns.map((t, i) => (t.clarify ? `${c.id}#${i + 1}` : "")).filter(Boolean)));
const expectSearch = new Set(cases.flatMap((c) => c.turns.map((t, i) => (!t.clarify && !t.out ? `${c.id}#${i + 1}` : "")).filter(Boolean)));

const cell = (ids: string[], d: (typeof data)[number][1]) => {
  const scored = ids.filter((id) => !d.unanswered.has(id));
  const wrong = scored.filter((id) => d.wrong.has(id));
  const unnecessary = wrong.filter((id) => expectSearch.has(id) && d.wrong.get(id)!.outcome === "clarify").length;
  const cascade = wrong.filter((id) => d.wrong.get(id)!.origin === "cascade").length;
  return `${scored.length - wrong.length}/${scored.length} (${scored.length ? ((100 * (scored.length - wrong.length)) / scored.length).toFixed(1) : "-"}%) · uncl ${unnecessary} · casc ${cascade}${ids.length - scored.length ? ` · unans ${ids.length - scored.length}` : ""}`;
};
console.log(`set ${SET}: ${cases.length} conversations; "uncl" = unnecessary clarifying question on a search turn, "casc" = right turn scored wrong because of an earlier mistake`);
console.log(`| group | turns | ${data.map(([n]) => n).join(" | ")} |`);
console.log(`|---|---:|${data.map(() => "---|").join("")}`);
for (const [g, { turns }] of [...rows].sort(([a], [b]) => (a === "ALL" ? 1 : b === "ALL" ? -1 : a.localeCompare(b)))) {
  console.log(`| ${g} | ${turns.length} | ${data.map(([, d]) => cell(turns, d)).join(" | ")} |`);
}
console.log(`\nexpected clarify turns: ${expectClarify.size}; missed: ${data.map(([n, d]) => `${n} ${[...expectClarify].filter((id) => d.wrong.has(id)).length}`).join(", ")}`);
// Turns one run got right and the other wrong (ids only; read the cases for the text)
if (data.length === 2) {
  const [[a, A], [b, B]] = data;
  const all = rows.get("ALL")!.turns.filter((id) => !A.unanswered.has(id) && !B.unanswered.has(id));
  console.log(`${b} fixed (wrong in ${a}, right in ${b}): ${all.filter((id) => A.wrong.has(id) && !B.wrong.has(id)).join(" ") || "-"}`);
  console.log(`${b} broke (right in ${a}, wrong in ${b}): ${all.filter((id) => !A.wrong.has(id) && B.wrong.has(id)).join(" ") || "-"}`);
  const origins = (d: typeof A) => Object.entries([...d.wrong.values()].reduce<Record<string, number>>((o, w) => ((o[w.origin ?? "?"] = (o[w.origin ?? "?"] ?? 0) + 1), o), {})).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`origins ${a}: ${origins(A)}\norigins ${b}: ${origins(B)}`);
}
