import { Message, SystemMessageKind } from "./types";

// Pure helpers for the Support thread (no React, no socket), so the merge and
// retry rules can be tested on their own (scripts/verify-support-client.ts).

export interface ServerMessage {
  _id: string;
  from: "user" | "admin" | "system";
  authorId: string | null;
  authorName: string | null;
  text: string;
  createdAt: string;
  kind?: SystemMessageKind;
  clientMessageId?: string;
}

export const GREETING_ID = "support-greeting";

export function greeting(): Message {
  return {
    id: GREETING_ID,
    role: "model",
    text: "Hi! You're now connected to Majestic Support. Tell us how we can help — an agent will respond shortly.",
    timestamp: new Date(),
    isSupport: true,
  };
}

export function toLocal(m: ServerMessage): Message {
  // Most server-generated "system" messages (join / handover / resolve / reopen)
  // render as centred italic chips — they are status events, not chat content.
  // The exception is `kind: "auto"` (the templated auto-acknowledgement we
  // send when a user first messages support): that's a *reply* to the user
  // and should render as a regular agent bubble so it visually matches the
  // greeting and any subsequent human admin replies.
  const renderAsAgent = m.from !== "user" && m.kind !== "join" && m.kind !== "handover" && m.kind !== "resolve" && m.kind !== "reopen";
  return {
    id: m._id,
    serverId: m._id,
    role: m.from === "user" ? "user" : renderAsAgent ? "model" : "system",
    text: m.text,
    timestamp: new Date(m.createdAt),
    isSupport: true,
    authorName: m.authorName,
    systemKind: m.kind,
    clientMessageId: m.clientMessageId,
  };
}

/**
 * The thread after the server sent its history (join, or a conversation
 * starting): the server's messages in its order, then whatever this device
 * still owes (sending / failed / unconfirmed bubbles the history doesn't
 * hold). Bubbles already on screen keep their React key — the optimistic one
 * a server copy replaces, and the greeting — so nothing fades in twice.
 */
export function mergeInto(prev: Message[], history: Message[]): Message[] {
  const byServer = new Map<string, Message>();
  const byClient = new Map<string, Message>();
  for (const m of prev) {
    if (m.serverId) byServer.set(m.serverId, m);
    if (m.clientMessageId) byClient.set(m.clientMessageId, m);
  }
  const held = new Set<string>();
  const out = history.map((h) => {
    if (h.clientMessageId) held.add(h.clientMessageId);
    const old = (h.serverId && byServer.get(h.serverId)) || (h.clientMessageId && byClient.get(h.clientMessageId)) || null;
    return old ? { ...h, id: old.id } : h;
  });
  if (!out.length) out.push(prev.find((m) => m.id === GREETING_ID) ?? greeting());
  for (const m of prev) {
    if (m.deliveryState && !(m.clientMessageId && held.has(m.clientMessageId))) out.push(m);
  }
  return out;
}

/** One live message: skipped if already shown, replaces its optimistic copy (same key), else appended. */
export function applyIncoming(prev: Message[], incoming: Message): Message[] {
  if (prev.some((m) => m.serverId && m.serverId === incoming.serverId)) return prev;
  if (incoming.clientMessageId) {
    const idx = prev.findIndex((m) => m.clientMessageId === incoming.clientMessageId);
    if (idx >= 0) {
      const next = prev.slice();
      next[idx] = { ...incoming, id: prev[idx].id };
      return next;
    }
  }
  return [...prev, incoming];
}

// ─── Outbox ──────────────────────────────────────────────────────────────────
//
// The server remembers a clientMessageId for at least 2 minutes (it caps how
// fast a conversation can grow so the id can't scroll out of its window), so
// resending with the SAME id inside that window can never store a message
// twice. Outside it — or into a different conversation than the one the
// message was meant for — a resend could duplicate or misplace it, so that is
// left to the person, with a warning.

export const RESEND_WINDOW_MS = 2 * 60_000;
export const ACK_TIMEOUT_MS = 10_000;
export const OUTBOX_MAX = 20;
export const PRE_ATTACH_MAX = 100;

export interface OutboxEntry {
  localId: string;
  clientMessageId: string;
  text: string;
  /** The conversation it was sent into; null = the draft (it starts one). */
  target: string | null;
  firstSentAt: number;
  autoResends: number;
  /** Bumped on every transmission, so a late answer to an older one is ignored. */
  attempt: number;
  /** A transmission is waiting for its answer. */
  inFlight: boolean;
  refused: boolean;
}

export type RejoinDecision = "delivered" | "resend" | "unconfirmed";

/** After a reconnect's join: what to do with a message the server never answered. */
export function decideOnRejoin(
  entry: OutboxEntry,
  joinedId: string | null,
  historyIds: Set<string>,
  now: number
): RejoinDecision {
  if (historyIds.has(entry.clientMessageId)) return "delivered";
  if (!entry.refused && entry.autoResends < 1 && now - entry.firstSentAt < RESEND_WINDOW_MS && entry.target === joinedId) {
    return "resend";
  }
  return "unconfirmed";
}

/**
 * A manual retry. "same-id": safe, the server dedupes it. "new-id": a message
 * the server refused (so it isn't stored) goes again as a new one.
 * "confirm": it may already be stored and the server can no longer tell —
 * ask the person first, then send it as a new one.
 */
export function retryKind(entry: OutboxEntry, currentTarget: string | null, now: number): "same-id" | "new-id" | "confirm" {
  if (entry.refused) return "new-id";
  if (now - entry.firstSentAt < RESEND_WINDOW_MS && entry.target === currentTarget) return "same-id";
  return "confirm";
}

export function newClientMessageId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
