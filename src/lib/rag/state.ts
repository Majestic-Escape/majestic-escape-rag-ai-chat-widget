// One search-state document per identity, in `ai_chat_state`.
//
// Ordering comes from two things together:
//  • the route runs one turn per identity at a time, in arrival order
//    (withKeyLock) — enough on a single instance;
//  • every commit names the `rev` it read. If another instance committed in
//    between, the write matches nothing and the turn re-reads and re-applies
//    its change to the newer state — it never overwrites it.

import { createHash } from "node:crypto";
import type { Collection } from "mongodb";
import type { SearchState } from "./types";
import type { Proposal } from "./understand";

/** A sign-in token was sent but did not verify (expired, or left behind after sign-out).
 *  That person's turns must not land in the browser's plain guest thread, which the next
 *  visitor on the same browser would restore, so they get a guest id of their own, tied
 *  to that token. Memory and history still work for them. */
export function guestIdForUnverifiedToken(guestId: string, bearer: string): string {
  return `${guestId}-t${createHash("sha256").update(bearer).digest("hex").slice(0, 12)}`;
}

export const IDLE_MS = 30 * 60_000; // after this a conversation starts a fresh search

/** A question waiting for a yes / no: see past unverifiable requirements, or make a change we were not sure of. */
export type Pending = { kind: "consent"; signature: string } | { kind: "confirm"; proposal: Proposal; question: string };

export interface StateDoc {
  rev: number;
  state: SearchState;
  pending: Pending | null;
  updatedAt: number; // ms
}

export interface StateStore {
  load(key: string): Promise<StateDoc | null>;
  /** Writes only if the stored `rev` is still `expectedRev` (0 = no document yet). */
  commit(key: string, expectedRev: number, next: Omit<StateDoc, "rev">): Promise<boolean>;
}

const USER_ID = /^[a-f0-9]{24}$/i;
const GUEST_ID = /^g_[A-Za-z0-9-]{8,64}$/; // the widget's `g_<uuid>` (utils.ts getOrCreateGuestId)

/** State belongs to exactly one identity; a caller with neither gets none.
 *  A guest's state is never carried into an account: the key simply changes. */
export function stateKey(userId: string | null, guestId: string | null): string | null {
  if (userId && USER_ID.test(userId)) return `u:${userId.toLowerCase()}`;
  if (!userId && guestId && GUEST_ID.test(guestId)) return `g:${guestId}`;
  return null;
}

export function isExpired(doc: StateDoc, now: number): boolean {
  return now - doc.updatedAt > IDLE_MS;
}

export function memoryStore(): StateStore & { docs: Map<string, StateDoc> } {
  const docs = new Map<string, StateDoc>();
  return {
    docs,
    async load(key) {
      const d = docs.get(key);
      return d ? structuredClone(d) : null;
    },
    async commit(key, expectedRev, next) {
      if ((docs.get(key)?.rev ?? 0) !== expectedRev) return false;
      docs.set(key, structuredClone({ ...next, rev: expectedRev + 1 }));
      return true;
    },
  };
}

type Row = { _id: string; rev: number; state: SearchState; pending: Pending | null; updatedAt: Date };

export function mongoStore(coll: Collection<Row>): StateStore {
  return {
    async load(key) {
      const d = await coll.findOne({ _id: key }, { maxTimeMS: 2000 });
      return d ? { rev: d.rev, state: d.state ?? {}, pending: d.pending ?? null, updatedAt: d.updatedAt.getTime() } : null;
    },
    async commit(key, expectedRev, next) {
      const fields = { state: next.state, pending: next.pending, updatedAt: new Date(next.updatedAt) };
      if (expectedRev === 0) {
        try {
          await coll.insertOne({ _id: key, rev: 1, ...fields }, { maxTimeMS: 2000 });
          return true;
        } catch (err) {
          if ((err as { code?: number }).code === 11000) return false; // someone else created it first
          throw err;
        }
      }
      const res = await coll.updateOne({ _id: key, rev: expectedRev }, { $set: fields, $inc: { rev: 1 } }, { maxTimeMS: 2000 });
      return res.matchedCount === 1;
    },
  };
}
