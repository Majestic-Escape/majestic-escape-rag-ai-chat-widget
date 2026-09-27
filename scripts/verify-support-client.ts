/**
 * Unit checks for the widget's Support thread rules (src/embed/supportThread.ts):
 * merging a server history without re-keying bubbles, live messages, and the
 * outbox's rejoin / retry decisions. No browser, no server.
 *
 *   npm run verify:support-client
 */
import {
  GREETING_ID,
  OutboxEntry,
  RESEND_WINDOW_MS,
  applyIncoming,
  decideOnRejoin,
  greeting,
  mergeInto,
  newClientMessageId,
  retryKind,
} from "../src/embed/supportThread";
import type { Message } from "../src/embed/types";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const at = new Date("2026-09-27T10:00:00Z");
const server = (id: string, text: string, cmid?: string, role: Message["role"] = "user"): Message => ({
  id,
  serverId: id,
  role,
  text,
  timestamp: at,
  isSupport: true,
  clientMessageId: cmid,
});
const pending = (cmid: string, text: string, state: Message["deliveryState"] = "sending"): Message => ({
  id: cmid,
  clientMessageId: cmid,
  role: "user",
  text,
  timestamp: at,
  isSupport: true,
  deliveryState: state,
});
const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  localId: "c_1",
  clientMessageId: "c_1",
  text: "hi",
  target: "conv1",
  firstSentAt: 1_000_000,
  autoResends: 0,
  attempt: 1,
  inFlight: false,
  refused: false,
  ...over,
});

console.log("mergeInto");
{
  const g = greeting();
  const out = mergeInto([g], []);
  check("empty history keeps the greeting already on screen (same object, no re-fade)", out.length === 1 && out[0] === g);
  const fresh = mergeInto([], []);
  check("empty history with nothing on screen shows a greeting", fresh.length === 1 && fresh[0].id === GREETING_ID);

  const prev = [g, pending("c_a", "hello")];
  const merged = mergeInto(prev, [server("s1", "hello", "c_a")]);
  check(
    "a server copy of an optimistic bubble keeps its key and clears its state",
    merged.length === 1 && merged[0].id === "c_a" && merged[0].serverId === "s1" && !merged[0].deliveryState,
    merged
  );

  const kept = mergeInto([g, pending("c_b", "still going", "unconfirmed")], [server("s1", "older", "c_x")]);
  check(
    "a bubble the history doesn't hold stays, after the history",
    kept.length === 2 && kept[0].serverId === "s1" && kept[1].id === "c_b" && kept[1].deliveryState === "unconfirmed",
    kept
  );

  const failedKept = mergeInto([pending("c_f", "refused", "failed")], []);
  check(
    "a refused bubble survives a join into a draft (after the greeting)",
    failedKept.length === 2 && failedKept[0].id === GREETING_ID && failedKept[1].id === "c_f",
    failedKept
  );

  const byServer = mergeInto([server("s9", "shown")], [server("s9", "shown"), server("s10", "new", undefined, "model")]);
  check("messages already shown keep their key; new ones are added", byServer.map((m) => m.id).join() === "s9,s10", byServer);

  const confirmedLocal = { ...server("s5", "x", "c_5"), id: "c_5" };
  const switched = mergeInto([confirmedLocal, server("s6", "other")], [server("s7", "someone else's thread")]);
  check("confirmed messages not in the new history go (another conversation)", switched.map((m) => m.id).join() === "s7", switched);
}

console.log("applyIncoming");
{
  const prev = [pending("c_a", "hello")];
  const replaced = applyIncoming(prev, server("s1", "hello", "c_a"));
  check("the echo replaces its optimistic bubble in place, same key", replaced.length === 1 && replaced[0].id === "c_a" && replaced[0].serverId === "s1" && !replaced[0].deliveryState, replaced);
  check("a message already shown is ignored (same array)", applyIncoming(replaced, server("s1", "hello", "c_a")) === replaced);
  const appended = applyIncoming(replaced, server("s2", "reply", undefined, "model"));
  check("a new message is appended", appended.length === 2 && appended[1].id === "s2");
}

console.log("decideOnRejoin");
{
  const now = 1_000_000 + 30_000;
  check("in the history → delivered", decideOnRejoin(entry(), "conv1", new Set(["c_1"]), now) === "delivered");
  check("same conversation, inside the window, first resend → resend", decideOnRejoin(entry(), "conv1", new Set(), now) === "resend");
  check("draft target, rejoined a draft → resend", decideOnRejoin(entry({ target: null }), null, new Set(), now) === "resend");
  check("draft target, rejoined a conversation → unconfirmed (never resent into it)", decideOnRejoin(entry({ target: null }), "conv2", new Set(), now) === "unconfirmed");
  check("different conversation → unconfirmed", decideOnRejoin(entry(), "conv2", new Set(), now) === "unconfirmed");
  check("conversation → rejoined a draft → unconfirmed", decideOnRejoin(entry(), null, new Set(), now) === "unconfirmed");
  check(
    "after the 2-minute window → unconfirmed",
    decideOnRejoin(entry(), "conv1", new Set(), 1_000_000 + RESEND_WINDOW_MS) === "unconfirmed"
  );
  check("already resent once → unconfirmed", decideOnRejoin(entry({ autoResends: 1 }), "conv1", new Set(), now) === "unconfirmed");
  check("refused → never resent automatically", decideOnRejoin(entry({ refused: true }), "conv1", new Set(), now) === "unconfirmed");
}

console.log("retryKind");
{
  const now = 1_000_000 + 60_000;
  check("inside the window, same conversation → same id (server dedupes)", retryKind(entry(), "conv1", now) === "same-id");
  check("refused → new id, no question (it isn't stored)", retryKind(entry({ refused: true }), "conv1", now) === "new-id");
  check("after the window → ask first", retryKind(entry(), "conv1", 1_000_000 + RESEND_WINDOW_MS + 1) === "confirm");
  check("another conversation now → ask first", retryKind(entry(), "conv2", now) === "confirm");
  check("draft target, still a draft → same id", retryKind(entry({ target: null }), null, now) === "same-id");
}

console.log("newClientMessageId");
{
  const ids = Array.from({ length: 5000 }, newClientMessageId);
  check("matches the server's accepted form", ids.every((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)), ids.find((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id)));
  check("5000 ids are unique", new Set(ids).size === ids.length);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
