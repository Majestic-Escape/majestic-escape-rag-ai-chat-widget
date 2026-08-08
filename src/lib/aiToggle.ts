// Ops kill-switch for the AI chatbot.
//
// Every AI reply costs money (Gemini → Groq → xAI). When the business is closed
// or ops are down, an admin flips this off from admin.site and the widget stops
// spending immediately. The flag is read server-side by /api/chat before any
// embedding or LLM call, so hiding the tab client-side is a UX nicety — this
// module is the thing that actually protects the bill.
//
// Source of truth: `settings` collection, document `_id: "ai-chat"`.
//
// FAIL-CLOSED CONTRACT — three rules, in priority order. `scripts/verify-ai-toggle.ts`
// asserts all three; keep them in lockstep.
//
//   1. Document absent            → ENABLED. Backward compatible: existing
//                                   deployments have no settings doc and must
//                                   keep working after this ships.
//   2. Read throws                → DISABLED. Fail closed; a DB blip must never
//                                   leave AI billing wide open.
//   3. Cache expired AND re-read
//      throws                     → DISABLED. The subtle one: a previously
//                                   cached `true` must NEVER be re-served past
//                                   its expiry just because the DB went away.
//
// Failing closed costs nothing real: this is the same Mongo connection
// /api/chat uses for Atlas Vector Search, so if Mongo is unreachable the RAG
// path is already broken. Better to show Support-only than to bill for a
// chatbot that cannot search anyway.

import { ObjectId } from "mongodb";
import clientPromise from "./mongodb";

const SETTINGS_COLLECTION = "settings";
const AI_CHAT_SETTING_ID = "ai-chat";

// Deliberately short. `resolveIsAdmin` caches for 5 minutes because admin status
// changes a few times a quarter; this guards money, so an ops flip must land in
// seconds, not minutes.
const CACHE_TTL_MS = 12_000;
// When a read fails we cache the `false` briefly so a Mongo outage doesn't turn
// every inbound chat request into another failing round-trip. Short enough that
// service resumes within seconds of Mongo recovering.
const FAILURE_CACHE_TTL_MS = 5_000;

interface AiChatSettingDoc {
  _id: string;
  enabled?: boolean;
  updatedAt?: Date;
  updatedBy?: ObjectId | null;
}

/**
 * Resolves the stored flag.
 *   `true` / `false` → the stored boolean
 *   `null`           → document absent (caller applies rule 1)
 *   throws           → read failure (caller applies rules 2 and 3)
 */
export type AiToggleReader = () => Promise<boolean | null>;

let cache: { enabled: boolean; expires: number } | null = null;

async function readFromDb(): Promise<boolean | null> {
  const client = await clientPromise;
  const doc = await client
    .db()
    .collection<AiChatSettingDoc>(SETTINGS_COLLECTION)
    .findOne({ _id: AI_CHAT_SETTING_ID }, { projection: { enabled: 1 } });

  if (!doc) return null;
  if (typeof doc.enabled !== "boolean") {
    // Document exists but the field is missing or the wrong type — that's
    // corruption, not a fresh install. Treat it as a read failure so we fail
    // closed rather than guessing that a malformed doc means "on".
    throw new Error(
      `settings/${AI_CHAT_SETTING_ID}.enabled is ${typeof doc.enabled}, expected boolean`
    );
  }
  return doc.enabled;
}

/**
 * Is the AI chatbot currently enabled?
 *
 * `reader` is injectable so `scripts/verify-ai-toggle.ts` can exercise the
 * fail-closed rules against the real implementation instead of a copy of it.
 * Production callers pass nothing.
 */
export async function isAiEnabled(
  reader: AiToggleReader = readFromDb
): Promise<boolean> {
  const now = Date.now();

  // Fresh cache — serve it. Note this is the ONLY path that reuses a cached
  // value; once `expires` passes we always go back to the reader (rule 3).
  if (cache && cache.expires > now) return cache.enabled;

  try {
    const stored = await reader();
    const enabled = stored === null ? true : stored; // rule 1
    cache = { enabled, expires: now + CACHE_TTL_MS };
    return enabled;
  } catch (err) {
    // Rules 2 and 3. We overwrite the cache with `false` rather than leaving the
    // stale entry in place, so there is no code path that can resurrect an
    // expired `true` while the DB is unreachable.
    cache = { enabled: false, expires: now + FAILURE_CACHE_TTL_MS };
    console.warn(
      "[aiToggle] read failed — failing closed (AI disabled):",
      (err as Error).message
    );
    return false;
  }
}

/**
 * Flip the switch. Records who did it and when, so there's an audit trail for a
 * change that directly affects customer-facing behaviour and spend.
 */
export async function setAiEnabled(
  enabled: boolean,
  updatedBy: string | null
): Promise<void> {
  const client = await clientPromise;
  await client
    .db()
    .collection<AiChatSettingDoc>(SETTINGS_COLLECTION)
    .updateOne(
      { _id: AI_CHAT_SETTING_ID },
      {
        $set: {
          enabled,
          updatedAt: new Date(),
          updatedBy:
            updatedBy && ObjectId.isValid(updatedBy)
              ? new ObjectId(updatedBy)
              : null,
        },
      },
      { upsert: true }
    );

  // Reflect the write immediately so the admin's own next read (and the config
  // endpoint the widget polls) doesn't show a stale value for up to CACHE_TTL_MS.
  cache = { enabled, expires: Date.now() + CACHE_TTL_MS };
}

// ── Verification hooks ──────────────────────────────────────────────
// Used only by scripts/verify-ai-toggle.ts. Not for production code paths.

/** Drop the cache entirely, as if the process had just started. */
export function __resetToggleCache(): void {
  cache = null;
}

/** Force the current cache entry to be expired without clearing its value. */
export function __expireToggleCache(): void {
  if (cache) cache.expires = 0;
}

/** Read the raw cache entry (verification assertions only). */
export function __peekToggleCache(): { enabled: boolean; expires: number } | null {
  return cache ? { ...cache } : null;
}
