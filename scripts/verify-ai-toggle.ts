// Asserts the fail-closed contract in src/lib/aiToggle.ts.
//
// Run:  npm run verify:ai-toggle
//
// This repo has no test runner by design (see CLAUDE.md), so this follows the
// standalone-script convention of scripts/createVectorIndex.js. It runs through
// `tsx` — already a dependency via `npm run dev` — specifically so it imports
// the REAL module rather than re-implementing its logic in a copy that could
// drift.
//
// Why this exists: the switch is a billing control, not a UI preference, and its
// three rules are easy for a future change to collapse into one branch. In
// particular, "document absent → enabled" and "read failed → disabled" look
// similar enough that a well-meaning refactor could merge them and silently
// leave AI billing on during a Mongo outage.
//
// No database is touched — the reader is stubbed.

import {
  isAiEnabled,
  __resetToggleCache,
  __expireToggleCache,
  __peekToggleCache,
} from "../src/lib/aiToggle";

let failures = 0;
let passes = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label} — expected ${expected}, got ${actual}`);
    failures++;
  }
}

const missingDoc = async () => null;
const storedTrue = async () => true;
const storedFalse = async () => false;
const readThrows = async (): Promise<boolean | null> => {
  throw new Error("simulated Mongo outage");
};

async function main(): Promise<void> {
  console.log("\n=== aiToggle fail-closed contract ===\n");

  // ── Rule 1: document absent → ENABLED (backward compatibility) ──
  __resetToggleCache();
  check("rule 1: missing settings doc → enabled", await isAiEnabled(missingDoc), true);

  // ── Rule 2: read throws → DISABLED (fail closed) ──
  __resetToggleCache();
  check("rule 2: Mongo read throws → disabled", await isAiEnabled(readThrows), false);

  // ── Rule 3: expired cache + read throws → DISABLED, never a stale `true` ──
  // This is the regression this script exists for. Warm a genuine `true` into
  // the cache first, then expire it and fail the re-read.
  __resetToggleCache();
  check("rule 3 setup: stored true → enabled", await isAiEnabled(storedTrue), true);
  check(
    "rule 3 setup: value really is cached",
    __peekToggleCache()?.enabled,
    true
  );
  __expireToggleCache();
  check(
    "rule 3: expired cache + read throws → disabled (no stale true)",
    await isAiEnabled(readThrows),
    false
  );
  check(
    "rule 3: cache was overwritten with false, not left stale",
    __peekToggleCache()?.enabled,
    false
  );

  // ── Supporting behaviour ──
  __resetToggleCache();
  check("stored false → disabled", await isAiEnabled(storedFalse), false);

  // A live cache must be served without consulting the reader, otherwise the
  // TTL is doing nothing and every chat request hits Mongo.
  __resetToggleCache();
  await isAiEnabled(storedTrue);
  let readerCalls = 0;
  const countingReader = async () => {
    readerCalls++;
    return false;
  };
  const cachedResult = await isAiEnabled(countingReader);
  check("live cache is served without a re-read", readerCalls, 0);
  check("live cache returns the cached value", cachedResult, true);

  console.log(
    `\nResult: ${passes} passed, ${failures} failed\n`
  );
  if (failures > 0) {
    console.error(
      "The fail-closed contract is broken. Do NOT ship — the AI kill-switch\n" +
        "may leave billing enabled during a database outage.\n"
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("verify-ai-toggle crashed:", err);
  process.exit(1);
});
