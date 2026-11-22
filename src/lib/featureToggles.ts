// Ops switches for the two non-AI chat surfaces an admin can hide:
//
//   support    → the Support tab / `/support` Socket.IO namespace (customers)
//   messaging  → guest↔host messaging (`majestic-chat` service, both directions)
//
// Source of truth: the `settings` collection of the shared app database, one
// document per switch (`support-chat`, `messaging`) — the same collection and
// shape as the AI switch in `aiToggle.ts`. `majestic-chat` reads the
// `messaging` document straight from that database (MAIN_DB_NAME), so keep the
// id and the `enabled: boolean` field in lockstep with
// `majestic-chat/.../lib/messagingToggle.ts`.
//
// FAIL-OPEN CONTRACT (the opposite of aiToggle, on purpose). The AI switch
// guards a bill, so a database blip must switch it OFF. These switches guard
// availability: hiding every customer's inbox because one Mongo read failed
// would be the outage this feature exists to prevent.
//
//   1. Document absent / never read → ENABLED (backward compatible).
//   2. Read throws                  → last value we saw, else ENABLED. Retried
//                                     after FAILURE_CACHE_TTL_MS.
//
// An admin's OFF is only ever lost to a *failed read with no prior value*,
// which no caller can induce.
//
// Enforcement is server-side everywhere this is used; the client copy only
// shapes the UI.

import { ObjectId } from "mongodb";
import clientPromise, { appDbName } from "./mongodb";

export type FeatureId = "support" | "messaging";
export const FEATURE_IDS: readonly FeatureId[] = ["support", "messaging"];

const SETTINGS_COLLECTION = "settings";
const DOC_ID: Record<FeatureId, string> = {
  support: "support-chat",
  messaging: "messaging",
};

// Short: an admin flip must reach every customer within seconds. Same value as
// the AI switch.
const CACHE_TTL_MS = 12_000;
const FAILURE_CACHE_TTL_MS = 5_000;
// While a switch is OFF, look again sooner: switching it back ON should reach
// the next customer within seconds, and the extra read is one findOne per 3 s
// per instance at most (single-flight), only while someone is asking.
const OFF_CACHE_TTL_MS = 3_000;
const ttlFor = (enabled: boolean): number => (enabled ? CACHE_TTL_MS : OFF_CACHE_TTL_MS);

interface FeatureSettingDoc {
  _id: string;
  enabled?: boolean;
  updatedAt?: Date;
  updatedBy?: ObjectId | null;
}

/** `true`/`false` → stored; `null` → document absent; throws → read failure. */
export type FeatureReader = (id: FeatureId) => Promise<boolean | null>;

const cache = new Map<FeatureId, { enabled: boolean; expires: number }>();
// One read in flight per switch: a burst of callers at expiry (the public config
// endpoint is unauthenticated) costs one findOne, not one each.
const inflight = new Map<FeatureId, Promise<boolean>>();
// Bumped by every admin write. A read that started before a flip and finishes
// after it must not overwrite the flip's value in the cache.
const writes = new Map<FeatureId, number>();
let loggedDb = false;

async function readFromDb(id: FeatureId): Promise<boolean | null> {
  const client = await clientPromise;
  const doc = await client
    .db(appDbName())
    .collection<FeatureSettingDoc>(SETTINGS_COLLECTION)
    .findOne({ _id: DOC_ID[id] }, { projection: { enabled: 1 } });
  if (!loggedDb) {
    // Once per process: which database the switches are written to. majestic-chat
    // must read the SAME one (its MAIN_DB_NAME) or admin flips are never seen there.
    loggedDb = true;
    console.info(`[featureToggles] switches live in database "${appDbName()}" (settings/${DOC_ID[id]}: ${doc ? String(doc.enabled) : "absent"})`);
  }
  if (!doc) return null;
  if (typeof doc.enabled !== "boolean") {
    throw new Error(`settings/${DOC_ID[id]}.enabled is ${typeof doc.enabled}, expected boolean`);
  }
  return doc.enabled;
}

/** Is this surface currently offered? `reader` is injectable for the verify script. */
export async function isFeatureEnabled(
  id: FeatureId,
  reader: FeatureReader = readFromDb
): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(id);
  if (hit && hit.expires > now) return hit.enabled;
  const pending = inflight.get(id);
  if (pending) return pending;

  const startedAtWrite = writes.get(id) ?? 0;
  const read = (async () => {
    try {
      const stored = await reader(id);
      const enabled = stored === null ? true : stored; // rule 1
      // An admin flip landed while we were reading: its value is newer than ours.
      if ((writes.get(id) ?? 0) !== startedAtWrite) return cache.get(id)?.enabled ?? enabled;
      cache.set(id, { enabled, expires: Date.now() + ttlFor(enabled) });
      return enabled;
    } catch (err) {
      // rule 2 — the value as of NOW (a flip may have landed during the read), else ON
      const enabled = cache.get(id)?.enabled ?? true;
      cache.set(id, { enabled, expires: Date.now() + FAILURE_CACHE_TTL_MS });
      console.warn(
        `[featureToggles] read of "${id}" failed — keeping ${enabled ? "ENABLED" : "DISABLED"}:`,
        (err as Error).message
      );
      return enabled;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, read);
  return read;
}

/**
 * Last value seen, synchronously and regardless of age (undefined before the
 * first read). For per-packet checks on live sockets, where awaiting would
 * reorder packets; a sweep keeps it fresh via isFeatureEnabled.
 */
export function peekFeature(id: FeatureId): boolean | undefined {
  return cache.get(id)?.enabled;
}

/** Both switches at once (admin GET + public config). */
export async function getFeatureFlags(
  reader: FeatureReader = readFromDb
): Promise<Record<FeatureId, boolean>> {
  const [support, messaging] = await Promise.all([
    isFeatureEnabled("support", reader),
    isFeatureEnabled("messaging", reader),
  ]);
  return { support, messaging };
}

/** Flip a switch, recording who and when (audit trail for a customer-facing change). */
export async function setFeatureEnabled(
  id: FeatureId,
  enabled: boolean,
  updatedBy: string | null
): Promise<void> {
  const client = await clientPromise;
  await client
    .db(appDbName())
    .collection<FeatureSettingDoc>(SETTINGS_COLLECTION)
    .updateOne(
      { _id: DOC_ID[id] },
      {
        $set: {
          enabled,
          updatedAt: new Date(),
          updatedBy: updatedBy && ObjectId.isValid(updatedBy) ? new ObjectId(updatedBy) : null,
        },
      },
      { upsert: true }
    );
  // The admin's own next read must not show the old value.
  writes.set(id, (writes.get(id) ?? 0) + 1);
  cache.set(id, { enabled, expires: Date.now() + ttlFor(enabled) });
}

// ── Verification hooks (scripts/verify-feature-toggles.ts only) ─────
export function __resetFeatureCache(): void {
  cache.clear();
  inflight.clear();
  writes.clear();
  loggedDb = false;
}
export function __expireFeatureCache(id: FeatureId): void {
  const hit = cache.get(id);
  if (hit) hit.expires = 0;
}
