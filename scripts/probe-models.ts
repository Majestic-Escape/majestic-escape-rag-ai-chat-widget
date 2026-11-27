// Latency + JSON-mode probe of candidate models (synthetic input only, no customer data).
//   npx tsx scripts/probe-models.ts nvidia:nvidia/nemotron-3.5-lightning-30b-a3b xai:grok-4.20-0309-non-reasoning …
// Uses the production client (llm.ts) with a long timeout signal, so a slow model shows its real time.
import { readFileSync } from "node:fs";
import { envKeys, newHealth, parseChain, proposeJson } from "../src/lib/rag/llm";

for (const f of [".env.local", "../majestic-escape-rag-ai-chat-widget/.env.local"]) {
  try {
    for (const l of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^"|"$/g, "");
    }
  } catch {}
}
const system = 'Return JSON only: {"place": string|null, "guests": number|null, "maxPrice": number|null}.';
const user = JSON.stringify({ message: "goa mein 6 logon ke liye villa chahiye 15k tak" });

(async () => {
  const specs = process.argv.slice(2);
  const rows = await Promise.all(
    specs.map(async (spec) => {
      const chain = parseChain(spec, envKeys());
      if (!chain.length) return `${spec}  no key`;
      const t: number[] = [];
      let last = "";
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const out = await proposeJson(system, user, { chain, fetch, reserve: async () => true, health: newHealth() }, new AbortController().signal);
        t.push(Date.now() - started);
        last = out.ok ? JSON.stringify(out.json).slice(0, 70) : `FAIL ${out.errors.join("; ").slice(0, 70)}`;
      }
      return `${spec.padEnd(48)} ${t.map((x) => `${x}ms`).join(" ")}  ${last}`;
    })
  );
  console.log(rows.join("\n"));
})();
