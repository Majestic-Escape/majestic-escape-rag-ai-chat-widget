// Asserts the FAIL-OPEN contract in src/lib/featureToggles.ts (support +
// messaging switches). The opposite of verify-ai-toggle: a failed read must
// never hide a customer-facing surface, and an admin's OFF must survive a blip.
//
// Run:  npm run verify:feature-toggles      (no database; the reader is stubbed)

import {
  isFeatureEnabled,
  getFeatureFlags,
  peekFeature,
  __resetFeatureCache,
  __expireFeatureCache,
} from "../src/lib/featureToggles";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) console.log(`  PASS  ${label}`);
  else {
    console.error(`  FAIL  ${label} — expected ${expected}, got ${actual}`);
    failures++;
  }
}

const missing = async () => null;
const stored = (v: boolean) => async () => v;
const throws = async (): Promise<boolean | null> => {
  throw new Error("simulated Mongo outage");
};

async function main(): Promise<void> {
  console.log("\n=== featureToggles fail-open contract ===\n");

  __resetFeatureCache();
  check("rule 1: missing doc → enabled", await isFeatureEnabled("messaging", missing), true);

  __resetFeatureCache();
  check("stored false → disabled", await isFeatureEnabled("messaging", stored(false)), false);
  check("stored false is cached (reader not consulted again)", await isFeatureEnabled("messaging", stored(true)), false);

  __resetFeatureCache();
  check("rule 2: never read + read throws → enabled", await isFeatureEnabled("support", throws), true);

  // The one that matters: an admin's OFF must not be lost to a database blip.
  __resetFeatureCache();
  await isFeatureEnabled("messaging", stored(false));
  __expireFeatureCache("messaging");
  check("rule 2: cached OFF + expired + read throws → stays disabled", await isFeatureEnabled("messaging", throws), false);

  __resetFeatureCache();
  await isFeatureEnabled("support", stored(true));
  __expireFeatureCache("support");
  check("cached ON + expired + read throws → stays enabled", await isFeatureEnabled("support", throws), true);

  __resetFeatureCache();
  check("peek before any read → undefined", peekFeature("support"), undefined);
  await isFeatureEnabled("support", stored(false));
  check("peek after read → last value", peekFeature("support"), false);
  __expireFeatureCache("support");
  check("peek ignores expiry (sync, per packet)", peekFeature("support"), false);

  __resetFeatureCache();
  const both = await getFeatureFlags(async (id) => (id === "support" ? false : null));
  check("switches are independent: support off", both.support, false);
  check("switches are independent: messaging on", both.messaging, true);

  // A malformed document is a read failure, not "off" and not a crash.
  __resetFeatureCache();
  const malformed = async (): Promise<boolean | null> => {
    throw new Error("settings/messaging.enabled is string, expected boolean");
  };
  check("malformed doc → enabled (fail-open), no throw", await isFeatureEnabled("messaging", malformed), true);

  // Single-flight: a burst at expiry (the public config endpoint) is ONE read.
  __resetFeatureCache();
  let reads = 0;
  const slow = async () => {
    reads++;
    await new Promise((r) => setTimeout(r, 20));
    return true as boolean | null;
  };
  await Promise.all(Array.from({ length: 100 }, () => isFeatureEnabled("messaging", slow)));
  check("100 concurrent callers at expiry → one read", reads, 1);

  console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
}
main();
