import { Server as IOServer, Socket, type Namespace } from "socket.io";
import { ObjectId, type ClientSession, type Collection, type Db, type Document } from "mongodb";
import clientPromise, { appDbName } from "./mongodb";
import { verifyToken, AppJwtPayload, resolveIsAdmin } from "./jwt";
import { checkRateLimit, withKeyLock, createSerialQueue, type SerialQueue } from "./rateLimit";
import { validateUserMessage, redactForLogs, sanitizeText } from "./moderation";
import { adminStanding, lookupAdminNames, lookupUserNames, personName, type PersonName } from "./supportNames";

const SUPPORT_MSG_LIMIT = 20; // 20 messages per minute per user/guest
const SUPPORT_MSG_WINDOW_MS = 60_000;
const MAX_MESSAGES_PER_CONVO = 500; // hard cap; older entries archived
// Every append to one conversation — customer, agent, system line, auto-ack —
// counts against 120 per fixed minute. Any 2 minutes then hold at most 360
// appends (480 across a restart), so a message a client may still retry
// (within 2 minutes, see useSupportChat) is always inside the 500-message
// ring, where the append filter detects the duplicate.
const CONVO_APPEND_LIMIT = 120;
const CONVO_APPEND_WINDOW_MS = 60_000;
const RATING_COMMENT_MAX = 500;
const WRITE_MAX_TIME_MS = 5_000;
const ADMIN_PAGE_SIZE = 50;
const PREVIEW_CHARS = 160;
const ADMIN_RECHECK_MS = 5 * 60_000;
// Widget bundles that send `proto: 2` understand a conversation that doesn't
// exist yet (a draft) and create it with their first message.
const DRAFT_PROTOCOL = 2;

export type SystemKind = "join" | "handover" | "resolve" | "reopen" | "auto";

interface SupportMessage {
  _id: ObjectId;
  from: "user" | "admin" | "system";
  authorId: ObjectId | null;
  authorName: string | null;
  text: string;
  createdAt: Date;
  readBy: ObjectId[];
  // Only present for from:"system" entries
  kind?: SystemKind;
  // Optimistic dedup id sent by the client
  clientMessageId?: string;
  // Commit order: the conversation's `rev` after this append. Absent on
  // messages written before revisions existed.
  seq?: number;
  // Running count of customer messages, on customer messages only.
  userIdx?: number;
}

interface AssignmentEntry {
  adminId: ObjectId;
  adminName: string;
  joinedAt: Date;
}

interface SupportRating {
  stars: number;
  comment: string | null;
  ratedAt: Date;
}

interface SupportChat {
  _id: ObjectId;
  userId: ObjectId | null;
  guestSessionId: string | null;
  // The name when the conversation was written. Only a fallback: agents are
  // shown the live name from `users` (see supportNames.ts).
  userFirstName: string | null;
  status: "open" | "pending" | "resolved";
  assignedAdminId: ObjectId | null;
  assignedAdminName: string | null;
  assignmentHistory: AssignmentEntry[];
  messages: SupportMessage[];
  rating: SupportRating | null;
  resolvedAt: Date | null;
  ratingDismissedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  unreadCounts: { user: number; admin: number };
  // "u:<userId>" | "g:<guestId>" while this is the owner's active
  // conversation; unique (partial index), so no two processes can create a
  // second one. Removed on resolve and on a guest→account claim.
  activeKey?: string;
  // How it came to exist: opened by a widget from before drafts, or created by
  // the customer's first message.
  createdBy?: "legacy-open" | "first-message";
  // +1 on every change an agent can see; events carry it so the console keeps
  // the newest state whatever order they arrive in.
  rev?: number;
  // Customer messages ever, and how many of them an agent has read.
  userMsgs?: number;
  readUserIdx?: { admin?: number };
}

interface AuditEntry {
  _id?: ObjectId;
  conversationId: ObjectId;
  actorId: ObjectId | null;
  actorName: string | null;
  action: "assign" | "handover" | "resolve" | "reopen" | "rate" | "delete";
  details?: Record<string, unknown>;
  ts: Date;
}

interface ConnContext {
  jwt: AppJwtPayload | null;
  isAdmin: boolean;
  guestSessionId: string | null;
  proto: number;
}

interface SocketState {
  queue: SerialQueue;
  // The customer's own name, read once and again after each start.
  userName: PersonName | null | undefined;
  claimed: boolean;
  startQueued: boolean;
  firstStartSeen: boolean;
  connectJoin: "running" | "ok" | "failed";
  retryFirstStart: boolean;
  startTimes: number[];
  timers: ReturnType<typeof setTimeout>[];
}

const ADMINS_ROOM = "admins:online";
const roomFor = (conversationId: string) => `support:${conversationId}`;
// Every customer socket joins its identity room when it connects, so it hears
// about its own conversations — including one another tab just started —
// without having joined that conversation's room yet.
const identityRoom = (key: string) => `identity:${key}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Untrusted input ────────────────────────────────────────────────────────
//
// The handshake `auth` object and every event payload are client JSON. A
// value declared as a string here can arrive as an object such as
// {"$ne": null}, which MongoDB reads as an operator: an unchecked guest id
// in the sign-in claim below would move every guest conversation into the
// caller's account. Anything that reaches a filter or a broadcast is
// checked here first.
const GUEST_ID_RE = /^[A-Za-z0-9_-]{1,100}$/; // the widget sends g_<uuid>
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseGuestSessionId(raw: unknown): string | null {
  return typeof raw === "string" && GUEST_ID_RE.test(raw) ? raw : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Ack = (r: { ok: boolean; error?: string; [key: string]: unknown }) => void;

// Socket.IO hands the handler whatever the client sent last; only a real
// callback is an acknowledgement.
function ackOf(raw: unknown): Ack {
  return typeof raw === "function" ? (raw as Ack) : () => {};
}

function payloadOf(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new Error("invalid payload");
  return raw;
}

interface ArchivedMessage {
  _id?: ObjectId;
  conversationId: ObjectId;
  message: SupportMessage;
  archivedAt: Date;
}

// ─── Collections and indexes ────────────────────────────────────────────────

let indexesReady: Promise<void> | null = null;

async function ensureIndexes(
  chats: Collection<SupportChat>,
  archive: Collection<ArchivedMessage>
): Promise<void> {
  try {
    await Promise.all([
      archive.createIndex({ conversationId: 1, "message._id": 1 }, { unique: true, name: "conv_msg_unique" }),
      // One active conversation per customer, across processes.
      chats.createIndex(
        { activeKey: 1 },
        { unique: true, name: "active_key_unique", partialFilterExpression: { activeKey: { $exists: true } } }
      ),
      chats.createIndex({ userId: 1, status: 1, updatedAt: -1 }, { name: "user_status_updated" }),
      chats.createIndex(
        { guestSessionId: 1, status: 1, updatedAt: -1 },
        { name: "guest_status_updated", partialFilterExpression: { guestSessionId: { $type: "string" } } }
      ),
      chats.createIndex({ status: 1, updatedAt: -1 }, { name: "status_updated" }),
      chats.createIndex({ updatedAt: -1, _id: -1 }, { name: "updated_id" }),
    ]);
  } catch (err) {
    console.warn("[support] failed to ensure indexes:", err);
    indexesReady = null; // retried on the next access
  }
}

async function getCollections() {
  const client = await clientPromise;
  const db = client.db(appDbName());
  const chats = db.collection<SupportChat>("support_chats");
  const archive = db.collection<ArchivedMessage>("support_chats_archive");
  if (!indexesReady) indexesReady = ensureIndexes(chats, archive);
  return {
    db,
    chats,
    archive,
    audit: db.collection<AuditEntry>("support_audit"),
    indexesReady,
  };
}

// ─── Identity ───────────────────────────────────────────────────────────────

function safeUserIdFromJwt(jwt: AppJwtPayload | null): ObjectId | null {
  const raw = jwt?.id ?? jwt?.userId;
  if (!raw || typeof raw !== "string") return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

// Strict guard for client-supplied conversation ids. Rejects non-strings (which
// would otherwise pass to the driver as Mongo operators like {$ne: null}) and
// returns a generic "invalid conversation id" instead of leaking driver internals.
function safeConversationId(raw: unknown): ObjectId {
  if (typeof raw !== "string" || !OBJECT_ID_RE.test(raw)) {
    throw new Error("invalid conversation id");
  }
  return new ObjectId(raw);
}

// The conversation filter for the socket's own identity, or null when it has
// none. Never build one from a missing identity: {guestSessionId: null}
// would match every signed-in customer's conversation.
function ownerFilterOf(
  ctx: ConnContext
): { userId: ObjectId } | { guestSessionId: string } | null {
  const userId = safeUserIdFromJwt(ctx.jwt);
  if (userId) return { userId };
  if (ctx.guestSessionId) return { guestSessionId: ctx.guestSessionId };
  return null;
}

function identityKeyOf(ctx: ConnContext): string | null {
  const userId = safeUserIdFromJwt(ctx.jwt);
  if (userId) return `u:${String(userId)}`;
  if (ctx.guestSessionId) return `g:${ctx.guestSessionId}`;
  return null;
}

function ownerKeyOfChat(chat: { userId: ObjectId | null; guestSessionId: string | null }): string | null {
  if (chat.userId) return `u:${String(chat.userId)}`;
  if (chat.guestSessionId) return `g:${chat.guestSessionId}`;
  return null;
}

function ownsConversation(
  ctx: ConnContext,
  chat: { userId: ObjectId | null; guestSessionId: string | null }
): boolean {
  const userId = safeUserIdFromJwt(ctx.jwt);
  if (userId) return !!chat.userId && chat.userId.equals(userId);
  return !!ctx.guestSessionId && chat.guestSessionId === ctx.guestSessionId;
}

// Only a fallback now: the names shown come from the records (supportNames).
function nameFromJwt(jwt: AppJwtPayload | null, fallback = "Agent"): string {
  const fn = jwt?.firstName;
  if (typeof fn === "string" && fn.trim()) return fn.trim();
  return fallback;
}

function stateOf(socket: Socket): SocketState {
  return (socket.data as { state: SocketState }).state;
}

function ctxOf(socket: Socket): ConnContext {
  return (socket.data as { ctx: ConnContext }).ctx;
}

// The customer's own name from `users`, read once per socket (again after a
// start) and only when a write needs it — opening the chat reads nothing.
async function customerName(socket: Socket): Promise<PersonName | null> {
  const state = stateOf(socket);
  if (state.userName !== undefined) return state.userName;
  const ctx = ctxOf(socket);
  const userId = safeUserIdFromJwt(ctx.jwt);
  let name: PersonName | null = null;
  if (userId) {
    try {
      const { db } = await getCollections();
      name = (await lookupUserNames(db, [userId])).get(String(userId)) ?? null;
    } catch (err) {
      console.warn("[support] customer name lookup failed:", (err as Error).message);
    }
    if (!name) {
      const first = nameFromJwt(ctx.jwt, "");
      name = first ? { first, last: "", full: first } : null;
    }
  }
  state.userName = name;
  return name;
}

// The acting agent, read fresh for every action: the name shown on what they
// do, and whether their `admins` record still allows it (a revoked agent is
// refused and disconnected on their next action, not after token expiry).
async function actingAdmin(socket: Socket): Promise<{ id: ObjectId; name: string }> {
  const ctx = ctxOf(socket);
  const id = safeUserIdFromJwt(ctx.jwt);
  if (!id) throw new Error("admin id missing in jwt");
  const { db } = await getCollections();
  const standing = await adminStanding(db, id);
  if (!standing.allowed) {
    setTimeout(() => socket.disconnect(true), 0);
    throw new Error("admin access revoked");
  }
  return { id, name: standing.name?.first ?? nameFromJwt(ctx.jwt, "Support") };
}

// What a customer sees of the assigned agent: the live first name.
async function liveAgentFirstName(db: Db, chat: Pick<SupportChat, "assignedAdminId" | "assignedAdminName">): Promise<string | null> {
  if (!chat.assignedAdminId) return chat.assignedAdminName ?? null;
  try {
    const names = await lookupAdminNames(db, [chat.assignedAdminId]);
    return names.get(String(chat.assignedAdminId))?.first ?? chat.assignedAdminName ?? null;
  } catch (err) {
    console.warn("[support] agent name lookup failed:", (err as Error).message);
    return chat.assignedAdminName ?? null;
  }
}

// ─── Broadcasts ─────────────────────────────────────────────────────────────

// A conversation's people: whoever is in its room, plus every socket of its
// owner (identity room). One emit reaches each socket once.
function toConversation(ns: Namespace, chat: { _id: ObjectId; userId: ObjectId | null; guestSessionId: string | null }) {
  const room = ns.to(roomFor(String(chat._id)));
  const owner = ownerKeyOfChat(chat);
  return owner ? room.to(identityRoom(owner)) : room;
}

function previewOf(message: Pick<SupportMessage, "_id" | "from" | "text" | "createdAt" | "kind" | "seq">) {
  return {
    _id: String(message._id),
    from: message.from,
    // by code point, like $substrCP in the inbox query: never half an emoji
    text: Array.from(message.text ?? "").slice(0, PREVIEW_CHARS).join(""),
    createdAt: message.createdAt,
    ...(message.kind ? { kind: message.kind } : {}),
    ...(typeof message.seq === "number" ? { seq: message.seq } : {}),
  };
}

// ─── Writes ─────────────────────────────────────────────────────────────────

const POST_IMAGE = {
  userId: 1,
  guestSessionId: 1,
  userFirstName: 1,
  status: 1,
  assignedAdminId: 1,
  assignedAdminName: 1,
  rating: 1,
  resolvedAt: 1,
  updatedAt: 1,
  unreadCounts: 1,
  rev: 1,
  userMsgs: 1,
  "messages._id": 1,
  "messages.from": 1,
  "messages.kind": 1,
  "messages.createdAt": 1,
  "messages.seq": 1,
  "messages.userIdx": 1,
} as const;

interface AppendOptions {
  // Conditions the conversation must still meet (state, ownership, expected
  // assignee). They sit in the write itself: nothing is checked-then-written.
  filter?: Document;
  // Plain values for top-level fields (applied as literals).
  set?: Document;
  unset?: string[];
  bumpUpdatedAt?: boolean;
  assignment?: AssignmentEntry;
  // An agent's reply takes a pending conversation: pending → open, assigned.
  promoteAgent?: { id: ObjectId; name: string };
}

// Appends one message and applies its state change in ONE atomic write
// (an update pipeline): the revision, the message's commit-order `seq`, the
// customer-message counters and the unread counts all move together.
// Returns the conversation after the write, or null when the conditions no
// longer hold — or when the clientMessageId is already in the ring.
async function appendMessage(
  chats: Collection<SupportChat>,
  conversationId: ObjectId,
  message: SupportMessage,
  opts: AppendOptions = {}
): Promise<SupportChat | null> {
  const isUser = message.from === "user";
  const isAgent = message.from === "admin";
  const filter: Document = { _id: conversationId, ...(opts.filter ?? {}) };
  if (message.clientMessageId) filter["messages.clientMessageId"] = { $ne: message.clientMessageId };

  const literal = (value: unknown) => ({ $literal: value });
  const first: Document = {
    rev: { $add: [{ $ifNull: ["$rev", 0] }, 1] },
    // Conversations from before the counters start from their unread count.
    userMsgs: {
      $add: [{ $ifNull: ["$userMsgs", { $ifNull: ["$unreadCounts.admin", 0] }] }, isUser ? 1 : 0],
    },
    readUserIdx: { admin: { $ifNull: ["$readUserIdx.admin", 0] } },
  };
  for (const [key, value] of Object.entries(opts.set ?? {})) first[key] = literal(value);
  if (opts.bumpUpdatedAt) first.updatedAt = literal(message.createdAt);
  if (opts.assignment) {
    first.assignmentHistory = { $concatArrays: [{ $ifNull: ["$assignmentHistory", []] }, [literal(opts.assignment)]] };
  }
  if (opts.promoteAgent) {
    const pending = { $eq: ["$status", "pending"] };
    first.status = { $cond: [pending, "open", "$status"] };
    first.assignedAdminId = { $cond: [pending, literal(opts.promoteAgent.id), "$assignedAdminId"] };
    first.assignedAdminName = { $cond: [pending, literal(opts.promoteAgent.name), "$assignedAdminName"] };
  }

  const stored = { $mergeObjects: [literal(message), { seq: "$rev" }, ...(isUser ? [{ userIdx: "$userMsgs" }] : [])] };
  const pipeline: Document[] = [
    { $set: first },
    {
      $set: {
        messages: {
          $slice: [{ $concatArrays: [{ $ifNull: ["$messages", []] }, [stored]] }, -MAX_MESSAGES_PER_CONVO],
        },
        unreadCounts: {
          admin: { $max: [0, { $subtract: ["$userMsgs", "$readUserIdx.admin"] }] },
          user: isAgent
            ? { $add: [{ $ifNull: ["$unreadCounts.user", 0] }, 1] }
            : { $ifNull: ["$unreadCounts.user", 0] },
        },
      },
    },
  ];
  if (opts.unset?.length) pipeline.push({ $unset: opts.unset });

  return chats.findOneAndUpdate(filter, pipeline, {
    returnDocument: "after",
    projection: POST_IMAGE,
    maxTimeMS: WRITE_MAX_TIME_MS,
  });
}

// The stored copy of a message just appended (with its `seq`/`userIdx`).
function storedMessage(post: SupportChat, message: SupportMessage): SupportMessage {
  const found = (post.messages ?? []).find((m) => m._id && m._id.equals(message._id));
  return { ...message, ...(found?.seq !== undefined ? { seq: found.seq } : {}), ...(found?.userIdx !== undefined ? { userIdx: found.userIdx } : {}) };
}

// The immutable log. Written after the ring push with up to 3 attempts; the
// unique (conversationId, message._id) index keeps retries idempotent. If
// every attempt fails the message still lives in the ring until 500 newer
// ones evict it — logged loudly (an accepted limitation, see ARCHITECTURE.md).
async function archiveMessage(
  archive: Collection<ArchivedMessage>,
  conversationId: ObjectId,
  message: SupportMessage
): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await archive.insertOne({ conversationId, message, archivedAt: new Date() });
      return;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return; // already archived
      lastErr = err;
      if (attempt < 2) await sleep(attempt === 0 ? 50 : 200);
    }
  }
  console.error(
    "[support] archive insert FAILED after 3 retries for message",
    String(message._id),
    "conv",
    String(conversationId),
    "err",
    lastErr
  );
}

function checkConversationRate(conversationId: string): void {
  const rl = checkRateLimit(`support:conv:${conversationId}`, CONVO_APPEND_LIMIT, CONVO_APPEND_WINDOW_MS);
  if (!rl.ok) throw new Error("This conversation is very busy — try again in a minute.");
}

async function logAudit(entry: Omit<AuditEntry, "ts">): Promise<void> {
  try {
    const { audit } = await getCollections();
    await audit.insertOne({ ...entry, ts: new Date() });
  } catch (err) {
    // Audit must never break the main flow
    console.warn("[support/audit] failed", err);
  }
}

function allowLight(socket: Socket, name: string, limit: number, windowMs: number): boolean {
  return checkRateLimit(`support:light:${socket.id}:${name}`, limit, windowMs).ok;
}

// ─── Namespace ──────────────────────────────────────────────────────────────

export function mountSupportNamespace(io: IOServer): void {
  const ns = io.of("/support");

  ns.use(async (socket, next) => {
    const auth = isPlainObject(socket.handshake.auth) ? socket.handshake.auth : {};
    const verified = verifyToken(typeof auth.token === "string" ? auth.token : undefined);
    const guestSessionId = parseGuestSessionId(auth.guestSessionId);
    const isAdmin = await resolveIsAdmin(verified);
    // A customer's token must name a real user id. One that doesn't is
    // dropped (verifyToken only proves the signature), so the socket is a
    // guest with a valid guest id, or nobody — and nobody is refused.
    const jwt = isAdmin || safeUserIdFromJwt(verified) ? verified : null;
    if (!isAdmin && !jwt && !guestSessionId) {
      return next(new Error("auth required: provide JWT token or guestSessionId"));
    }
    const proto = typeof auth.proto === "number" && Number.isInteger(auth.proto) ? auth.proto : 1;
    const ctx: ConnContext = { jwt, isAdmin, guestSessionId, proto };
    (socket.data as { ctx: ConnContext }).ctx = ctx;
    next();
  });

  ns.on("connection", (socket: Socket) => {
    const ctx = ctxOf(socket);
    const state: SocketState = {
      queue: createSerialQueue(32, 15_000),
      userName: undefined,
      claimed: false,
      startQueued: false,
      firstStartSeen: false,
      connectJoin: "running",
      retryFirstStart: false,
      startTimes: [],
      timers: [],
    };
    (socket.data as { state: SocketState }).state = state;

    // Identity is only checked at the handshake, so a socket must not outlive
    // its token.
    if (typeof ctx.jwt?.exp === "number") {
      const ms = Math.min(Math.max(ctx.jwt.exp * 1000 - Date.now(), 0), 2_147_483_647);
      state.timers.push(setTimeout(() => socket.disconnect(true), ms));
    }
    if (ctx.isAdmin) {
      // An agent whose access is revoked while the console stays open.
      const adminId = safeUserIdFromJwt(ctx.jwt);
      if (adminId) {
        state.timers.push(
          setInterval(() => {
            getCollections()
              .then(({ db }) => adminStanding(db, adminId))
              .then((standing) => {
                if (!standing.allowed) socket.disconnect(true);
              })
              .catch(() => {});
          }, ADMIN_RECHECK_MS)
        );
      }
    } else {
      const key = identityKeyOf(ctx);
      if (key) socket.join(identityRoom(key));
    }

    const join = () => (ctx.isAdmin ? onAdminConnect(socket) : onUserConnect(ns, socket));
    const reportJoinFailure = (err: unknown) => {
      console.error("[support] join failed", err);
      socket.emit("support:error", {
        reason: ctx.isAdmin ? "Couldn't load conversations. Retrying…" : "Couldn't load your conversation. Please try again.",
      });
    };
    const requestStart = () => {
      if (state.startQueued) return;
      state.startQueued = true;
      const now = Date.now();
      state.startTimes = state.startTimes.filter((t) => now - t < 10_000);
      state.startTimes.push(now);
      const throttled = state.startTimes.length > 5;
      state.queue
        .run(async () => {
          state.startQueued = false;
          if (throttled) await sleep(500);
          state.userName = undefined; // a start re-reads the customer's name
          await join();
        })
        .catch((err) => {
          state.startQueued = false;
          reportJoinFailure(err);
        });
    };

    // One join per connection, started right away (no round trip waits for
    // the client). The client still sends `support:start` on every connect;
    // that first one is answered by this join unless it failed.
    state.queue.run(join).then(
      () => {
        state.connectJoin = "ok";
      },
      (err) => {
        state.connectJoin = "failed";
        reportJoinFailure(err);
        if (state.retryFirstStart) requestStart();
      }
    );

    // Starts are never dropped: at most one runs and one waits per socket, and
    // every start gets an answer that reflects the state after it.
    socket.on("support:start", () => {
      if (!ctx.isAdmin && !state.firstStartSeen) {
        state.firstStartSeen = true;
        if (state.connectJoin === "ok") return;
        if (state.connectJoin === "running") {
          state.retryFirstStart = true;
          return;
        }
      }
      requestStart();
    });

    socket.on("support:message", (payload: unknown, ack: unknown) => {
      const reply = ackOf(ack);
      state.queue.run(() => handleIncomingMessage(ns, socket, payload)).then(
        (result) => reply({ ok: true, ...result }),
        (err) => {
          console.error("[support] message error", err);
          reply({ ok: false, error: (err as Error).message });
        }
      );
    });

    socket.on("support:read", (payload: unknown) => {
      if (!allowLight(socket, "read", 30, 60_000)) return;
      handleRead(ns, socket, payload).catch((err) => console.error("[support] read error", err));
    });

    socket.on("support:typing", (payload: unknown) => {
      // Only into a conversation this socket is in (joined after its
      // ownership or agent check) — no database read per keystroke — and
      // rate-limited per socket.
      try {
        if (!isPlainObject(payload)) return;
        if (!allowLight(socket, "typing", 10, 10_000)) return;
        const id = String(safeConversationId(payload.conversationId));
        if (!socket.rooms.has(roomFor(id))) return;
        socket.to(roomFor(id)).emit("support:typing", {
          conversationId: id,
          from: ctx.isAdmin ? "admin" : "user",
          isTyping: payload.isTyping === true,
        });
      } catch (err) {
        console.warn("[support] typing rejected:", (err as Error).message);
      }
    });

    const adminAction = (
      event: string,
      handler: (ns: Namespace, socket: Socket, payload: unknown) => Promise<void>
    ) => {
      socket.on(event, (payload: unknown, ack: unknown) => {
        const reply = ackOf(ack);
        if (!ctx.isAdmin) {
          reply({ ok: false, error: "admin only" });
          return;
        }
        state.queue.run(() => handler(ns, socket, payload)).then(
          () => reply({ ok: true }),
          (err) => {
            console.error(`[support] ${event} error`, err);
            reply({ ok: false, error: (err as Error).message });
          }
        );
      });
    };
    adminAction("support:assign", handleAssign);
    adminAction("support:resolve", handleResolve);
    adminAction("support:reopen", handleReopen);

    socket.on("support:rate", (payload: unknown, ack: unknown) => {
      const reply = ackOf(ack);
      state.queue.run(() => handleRate(ns, socket, payload)).then(
        () => reply({ ok: true }),
        (err) => {
          console.error("[support] rate error", err);
          reply({ ok: false, error: (err as Error).message });
        }
      );
    });

    // Replays the full conversation history (archive + live ring) to the
    // requesting socket. Used by the admin reply console when an agent opens a
    // conversation. Compliance: every message ever sent is preserved and
    // returned here, including those evicted from the 500-message ring.
    socket.on("support:fetch-history", (payload: unknown, ack: unknown) => {
      const reply = ackOf(ack);
      if (!allowLight(socket, "history", 10, 60_000)) {
        reply({ ok: false, error: "too many requests — try again in a moment" });
        return;
      }
      handleFetchHistory(socket, payload).then(
        () => reply({ ok: true }),
        (err) => {
          console.error("[support] fetch-history error", err);
          reply({ ok: false, error: (err as Error).message });
        }
      );
    });

    // Older inbox pages (agents), by cursor.
    socket.on("support:admin-more", (payload: unknown, ack: unknown) => {
      const reply = ackOf(ack);
      if (!ctx.isAdmin) {
        reply({ ok: false, error: "admin only" });
        return;
      }
      if (!allowLight(socket, "admin-more", 30, 60_000)) {
        reply({ ok: false, error: "too many requests — try again in a moment" });
        return;
      }
      Promise.resolve()
        .then(() => adminPage(parseCursor(payloadOf(payload).before)))
        .then(
          (page) => reply({ ok: true, conversations: page.rows, hasMore: page.hasMore, openCount: page.openCount }),
          (err) => {
            console.error("[support] admin-more error", err);
            reply({ ok: false, error: (err as Error).message });
          }
        );
    });

    socket.on("support:rating-dismissed", (payload: unknown, ack: unknown) => {
      const reply = ackOf(ack);
      state.queue
        .run(async () => {
          // Only the customer who was asked for the rating can skip it; the
          // ownership condition sits in the write itself.
          const owner = ctx.isAdmin ? null : ownerFilterOf(ctx);
          if (!owner) throw new Error("not your conversation");
          const conversationId = safeConversationId(payloadOf(payload).conversationId);
          const { chats } = await getCollections();
          const result = await chats.updateOne(
            { _id: conversationId, ...owner },
            { $set: { ratingDismissedAt: new Date() } },
            { maxTimeMS: WRITE_MAX_TIME_MS }
          );
          if (result.matchedCount === 0) throw new Error("not your conversation");
        })
        .then(
          // Ack so the client can sequence: dismiss → wait for ack → start a
          // new conversation. Without it, support:start could race past the
          // dismiss write and re-find the unrated conversation.
          () => reply({ ok: true }),
          (err) => {
            console.error("[support] rating-dismissed error", err);
            reply({ ok: false, error: (err as Error).message });
          }
        );
    });

    socket.on("disconnect", () => {
      // Rooms are cleaned up by Socket.IO automatically.
      for (const t of state.timers) clearTimeout(t);
      state.timers.length = 0;
    });
  });
}

// ─── Customer connect ───────────────────────────────────────────────────────

async function findActive(
  chats: Collection<SupportChat>,
  owner: { userId: ObjectId } | { guestSessionId: string }
): Promise<SupportChat | null> {
  const docs = await chats
    .find({ ...owner, status: { $ne: "resolved" as const } }, { sort: { updatedAt: -1 }, limit: 10, maxTimeMS: WRITE_MAX_TIME_MS })
    .toArray();
  // Older data can hold more than one; the one with the conversation in it wins.
  const human = (c: SupportChat) => (c.messages ?? []).some((m) => m.from === "user" || m.from === "admin");
  return docs.find(human) ?? docs[0] ?? null;
}

async function onUserConnect(ns: Namespace, socket: Socket): Promise<void> {
  const ctx = ctxOf(socket);
  const state = stateOf(socket);
  const key = identityKeyOf(ctx);
  const owner = ownerFilterOf(ctx);
  if (!key || !owner) {
    socket.emit("support:error", { reason: "Sign in to chat with support." });
    return;
  }

  // No connect-time rate limit — every page reload, network blip, or tab
  // switch reconnects the support socket. The per-message limits below are
  // the real spam guard.

  // Sign-in upgrade: once per socket, and only when this browser has guest
  // history to bring along.
  const userId = safeUserIdFromJwt(ctx.jwt);
  if (userId && ctx.guestSessionId && !state.claimed) {
    state.claimed = true;
    await claimGuestHistory(ns, socket, userId, ctx.guestSessionId);
  }

  await withKeyLock(key, async () => {
    const { chats } = await getCollections();
    const chat = await findActive(chats, owner);
    if (chat) {
      await attach(socket, chat, false);
      return;
    }

    // A recently resolved conversation still waiting for its rating comes
    // first, so the rating prompt shows before anything new starts.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const awaiting = await chats.findOne(
      { ...owner, status: "resolved", rating: null, ratingDismissedAt: null, resolvedAt: { $gte: sevenDaysAgo } },
      { sort: { resolvedAt: -1 }, maxTimeMS: WRITE_MAX_TIME_MS }
    );
    if (awaiting) {
      await attach(socket, awaiting, true);
      return;
    }

    if (ctx.proto >= DRAFT_PROTOCOL) {
      // Nothing is written until the customer sends their first message, so
      // opening the chat never reaches an agent's inbox.
      socket.emit("support:joined", {
        conversationId: null,
        history: [],
        status: null,
        assignedAdminId: null,
        assignedAdminName: null,
        rating: null,
        awaitingRating: false,
      });
      return;
    }

    // A widget bundle from before drafts can only send into an existing
    // conversation, so it still gets one on open — marked, and never
    // announced: it reaches the inbox with its first customer message.
    if (!userId) {
      socket.emit("support:error", { reason: "Sign in to chat with support." });
      return;
    }
    const { chat: created } = await createConversation(socket, "legacy-open");
    // The customer's other tabs (a newer widget sitting in a draft) join it too.
    ns.in(identityRoom(key)).socketsJoin(roomFor(String(created._id)));
    ns.to(identityRoom(key)).except(socket.id).emit("support:started", {
      conversationId: String(created._id),
      status: created.status,
      assignedAdminId: null,
      assignedAdminName: null,
      history: created.messages ?? [],
    });
    await attach(socket, created, false);
  });
}

async function attach(socket: Socket, chat: SupportChat, awaitingRating: boolean): Promise<void> {
  const { db, chats } = await getCollections();
  const id = String(chat._id);
  socket.join(roomFor(id));
  const [, agentName] = await Promise.all([
    awaitingRating
      ? Promise.resolve()
      : chats.updateOne({ _id: chat._id }, { $set: { "unreadCounts.user": 0 } }, { maxTimeMS: WRITE_MAX_TIME_MS }),
    liveAgentFirstName(db, chat),
  ]);
  socket.emit("support:joined", {
    conversationId: id,
    history: chat.messages ?? [],
    status: chat.status,
    assignedAdminId: chat.assignedAdminId ? String(chat.assignedAdminId) : null,
    assignedAdminName: agentName,
    rating: chat.rating,
    awaitingRating,
  });
}

// Inserts the customer's active conversation. The unique `activeKey` index
// makes this safe across processes: a losing insert attaches to the winner.
async function createConversation(
  socket: Socket,
  createdBy: "legacy-open" | "first-message"
): Promise<{ chat: SupportChat; created: boolean }> {
  const ctx = ctxOf(socket);
  const userId = safeUserIdFromJwt(ctx.jwt);
  if (!userId) throw new Error("Sign in to message support.");
  const { chats, indexesReady: ready } = await getCollections();
  await ready;
  const name = await customerName(socket);
  const now = new Date();
  const doc: SupportChat = {
    _id: new ObjectId(),
    userId,
    guestSessionId: null,
    userFirstName: name?.first ?? nameFromJwt(ctx.jwt, "User"),
    status: "pending",
    assignedAdminId: null,
    assignedAdminName: null,
    assignmentHistory: [],
    messages: [],
    rating: null,
    resolvedAt: null,
    ratingDismissedAt: null,
    createdAt: now,
    updatedAt: now,
    unreadCounts: { user: 0, admin: 0 },
    activeKey: `u:${String(userId)}`,
    createdBy,
    rev: 0,
    userMsgs: 0,
    readUserIdx: { admin: 0 },
  };
  try {
    await chats.insertOne(doc, { maxTimeMS: WRITE_MAX_TIME_MS });
    return { chat: doc, created: true };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const existing = await findActive(chats, { userId });
      if (existing) return { chat: existing, created: false };
    }
    throw err;
  }
}

// The sign-in upgrade: guest support conversations and guest AI history of
// this browser move to the account together — one transaction, so a failure
// between the two writes moves neither — under the guest's lock, so two
// accounts signing in on one browser at once can't split them. Guest-only
// sockets then leave the claimed rooms before anything else is delivered.
async function claimGuestHistory(ns: Namespace, socket: Socket, userId: ObjectId, guestId: string): Promise<void> {
  const { db, chats } = await getCollections();
  const ai = db.collection("ai_chat_messages");
  const [hasChat, hasAi] = await Promise.all([
    chats.findOne({ userId: null, guestSessionId: guestId }, { projection: { _id: 1 }, maxTimeMS: WRITE_MAX_TIME_MS }),
    ai.findOne({ userId: null, guestSessionId: guestId }, { projection: { _id: 1 }, maxTimeMS: WRITE_MAX_TIME_MS }),
  ]);
  if (!hasChat && !hasAi) return;
  const name = await customerName(socket);

  await withKeyLock(`g:${guestId}`, async () => {
    let claimed: ObjectId[] = [];
    const move = async (session?: ClientSession) => {
      claimed = (
        await chats.find({ userId: null, guestSessionId: guestId }, { projection: { _id: 1 }, session }).toArray()
      ).map((d) => d._id);
      if (claimed.length) {
        await chats.updateMany(
          { _id: { $in: claimed }, userId: null, guestSessionId: guestId },
          { $set: { userId, guestSessionId: null, userFirstName: name?.first ?? "User" }, $unset: { activeKey: "" } },
          { session }
        );
      }
      await ai.updateMany({ userId: null, guestSessionId: guestId }, { $set: { userId, guestSessionId: null } }, { session });
    };
    const client = await clientPromise;
    const session = client.startSession();
    try {
      await session.withTransaction(() => move(session), { maxCommitTimeMS: WRITE_MAX_TIME_MS });
    } catch (err) {
      // Only a server without transactions (a standalone development mongod)
      // falls back to the two plain writes; Atlas is a replica set.
      const msg = String((err as Error)?.message ?? "");
      if (!/replica set|Transaction numbers/i.test(msg)) throw err;
      console.warn("[support] transactions unavailable — guest claim without one");
      await move();
    } finally {
      await session.endSession().catch(() => {});
    }
    for (const id of claimed) ns.in(identityRoom(`g:${guestId}`)).socketsLeave(roomFor(String(id)));
  });
}

// ─── Agent inbox ────────────────────────────────────────────────────────────

interface AdminRow {
  conversationId: string;
  userId: string | null;
  guestSessionId: string | null;
  userFirstName: string;
  userLastName: string;
  userName: string;
  status: SupportChat["status"];
  lastMessage: ReturnType<typeof previewOf> | null;
  unread: number;
  updatedAt: Date;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  rating: SupportRating | null;
  resolvedAt: Date | null;
  rev: number;
}

function parseCursor(raw: unknown): { updatedAt: Date; id: ObjectId } | undefined {
  if (raw == null) return undefined;
  if (!isPlainObject(raw) || typeof raw.updatedAt !== "string" || typeof raw.id !== "string" || !OBJECT_ID_RE.test(raw.id)) {
    throw new Error("invalid cursor");
  }
  const updatedAt = new Date(raw.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) throw new Error("invalid cursor");
  return { updatedAt, id: new ObjectId(raw.id) };
}

// One page of the inbox: every conversation someone actually wrote in,
// newest first, 50 at a time by (updatedAt, _id) cursor — the index walk
// does the sorting (no in-memory sort; Atlas M0 caps those at 32 MB). The
// names come from the records in the same round trip ($lookup), the preview
// is the last message a person wrote, truncated on the server.
async function adminPage(before?: { updatedAt: Date; id: ObjectId }): Promise<{ rows: AdminRow[]; hasMore: boolean; openCount: number }> {
  const { chats } = await getCollections();
  const human = { "messages.from": { $in: ["user", "admin"] } };
  const match: Document = { ...human };
  if (before) {
    match.$or = [{ updatedAt: { $lt: before.updatedAt } }, { updatedAt: before.updatedAt, _id: { $lt: before.id } }];
  }
  const namePipeline = [{ $project: { firstName: 1, lastName: 1 } }];
  const [docs, openCount] = await Promise.all([
    chats
      .aggregate<Document>(
        [
          { $match: match },
          { $sort: { updatedAt: -1, _id: -1 } },
          { $limit: ADMIN_PAGE_SIZE + 1 },
          {
            $project: {
              userId: 1,
              guestSessionId: 1,
              userFirstName: 1,
              status: 1,
              unreadCounts: 1,
              updatedAt: 1,
              assignedAdminId: 1,
              assignedAdminName: 1,
              rating: 1,
              resolvedAt: 1,
              rev: 1,
              preview: {
                $arrayElemAt: [{ $filter: { input: "$messages", cond: { $in: ["$$this.from", ["user", "admin"]] } } }, -1],
              },
            },
          },
          {
            $set: {
              preview: {
                $cond: [
                  { $ifNull: ["$preview", false] },
                  {
                    _id: "$preview._id",
                    from: "$preview.from",
                    text: { $substrCP: [{ $ifNull: ["$preview.text", ""] }, 0, PREVIEW_CHARS] },
                    createdAt: "$preview.createdAt",
                    seq: "$preview.seq",
                  },
                  null,
                ],
              },
            },
          },
          { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "_user", pipeline: namePipeline } },
          { $lookup: { from: "admins", localField: "assignedAdminId", foreignField: "_id", as: "_agent", pipeline: namePipeline } },
          { $lookup: { from: "users", localField: "assignedAdminId", foreignField: "_id", as: "_agentUser", pipeline: namePipeline } },
        ],
        { maxTimeMS: WRITE_MAX_TIME_MS }
      )
      .toArray(),
    chats.countDocuments({ status: { $in: ["pending", "open"] }, ...human }, { maxTimeMS: WRITE_MAX_TIME_MS }),
  ]);
  const hasMore = docs.length > ADMIN_PAGE_SIZE;
  return { rows: docs.slice(0, ADMIN_PAGE_SIZE).map(rowFrom), hasMore, openCount };
}

function rowFrom(doc: Document): AdminRow {
  const user = personName(doc._user?.[0]);
  const agent = personName(doc._agent?.[0]) ?? personName(doc._agentUser?.[0]);
  const stored = typeof doc.userFirstName === "string" && doc.userFirstName ? doc.userFirstName : doc.userId ? "User" : "Guest";
  return {
    conversationId: String(doc._id),
    userId: doc.userId ? String(doc.userId) : null,
    guestSessionId: doc.guestSessionId ?? null,
    userFirstName: user?.first ?? stored,
    userLastName: user?.last ?? "",
    userName: user?.full ?? stored,
    status: doc.status,
    lastMessage: doc.preview ? { ...doc.preview, _id: String(doc.preview._id) } : null,
    unread: doc.unreadCounts?.admin ?? 0,
    updatedAt: doc.updatedAt,
    assignedAdminId: doc.assignedAdminId ? String(doc.assignedAdminId) : null,
    assignedAdminName: agent?.first ?? doc.assignedAdminName ?? null,
    rating: doc.rating ?? null,
    resolvedAt: doc.resolvedAt ?? null,
    rev: typeof doc.rev === "number" ? doc.rev : 0,
  };
}

async function onAdminConnect(socket: Socket): Promise<void> {
  socket.join(ADMINS_ROOM);
  const page = await adminPage();
  socket.emit("support:admin-init", { conversations: page.rows, hasMore: page.hasMore, openCount: page.openCount });
}

// The row an agent's inbox gains when a conversation's first customer
// message lands — built from the write's own result, no extra read.
async function newConversationRow(
  db: Db,
  post: SupportChat,
  message: SupportMessage,
  sender: PersonName | null
): Promise<AdminRow> {
  const stored = post.userFirstName || (post.userId ? "User" : "Guest");
  return {
    conversationId: String(post._id),
    userId: post.userId ? String(post.userId) : null,
    guestSessionId: post.guestSessionId ?? null,
    userFirstName: sender?.first ?? stored,
    userLastName: sender?.last ?? "",
    userName: sender?.full ?? stored,
    status: post.status,
    lastMessage: previewOf(message),
    unread: post.unreadCounts?.admin ?? 0,
    updatedAt: post.updatedAt,
    assignedAdminId: post.assignedAdminId ? String(post.assignedAdminId) : null,
    assignedAdminName: await liveAgentFirstName(db, post),
    rating: post.rating ?? null,
    resolvedAt: post.resolvedAt ?? null,
    rev: post.rev ?? 0,
  };
}

// ─── Messages ───────────────────────────────────────────────────────────────

interface SendResult {
  conversationId: string;
  messageId: string;
  duplicate?: boolean;
}

async function handleIncomingMessage(ns: Namespace, socket: Socket, payload: unknown): Promise<SendResult> {
  const ctx = ctxOf(socket);
  const body = payloadOf(payload);

  const v = validateUserMessage(body.text);
  if (!v.ok) throw new Error(v.reason ?? "invalid message");
  const text = sanitizeText((body.text as string).trim());
  if (!text) throw new Error("Message is empty");

  // clientMessageId must be a short token if provided — it is stored and
  // matched on, so block operator injection and oversized values.
  let clientMessageId: string | undefined = undefined;
  if (body.clientMessageId !== undefined && body.clientMessageId !== null) {
    if (typeof body.clientMessageId !== "string" || !CLIENT_MESSAGE_ID_RE.test(body.clientMessageId)) {
      throw new Error("invalid clientMessageId");
    }
    clientMessageId = body.clientMessageId;
  }

  const authorId = safeUserIdFromJwt(ctx.jwt);
  const rateKey = ctx.isAdmin
    ? `support:admin:${authorId ?? socket.id}`
    : authorId
    ? `support:user:${authorId}`
    : `support:guest:${ctx.guestSessionId ?? socket.id}`;
  const rl = checkRateLimit(rateKey, SUPPORT_MSG_LIMIT, SUPPORT_MSG_WINDOW_MS);
  if (!rl.ok) {
    console.warn(`[support] rate limited ${rateKey}; sample=${redactForLogs(text).slice(0, 80)}`);
    throw new Error("rate limit exceeded — try again in a moment");
  }

  const { db, chats, archive } = await getCollections();
  const owner = ownerFilterOf(ctx);

  // A draft (the customer has no conversation yet): the first message creates
  // it. Only `null` means "none yet", and only from a draft-capable widget.
  let conversationId: ObjectId;
  if (body.conversationId === null && !ctx.isAdmin && ctx.proto >= DRAFT_PROTOCOL) {
    const key = identityKeyOf(ctx);
    if (!authorId || !key) throw new Error("Sign in to message support.");
    const { chat } = await withKeyLock(key, async () => {
      const found = await findActive(chats, { userId: authorId });
      if (found) return { chat: found, created: false };
      return createConversation(socket, "first-message");
    });
    // Every tab of this customer joins the conversation and learns its id
    // before the message itself is broadcast.
    const id = String(chat._id);
    ns.in(identityRoom(key)).socketsJoin(roomFor(id));
    ns.to(identityRoom(key)).emit("support:started", {
      conversationId: id,
      status: chat.status,
      assignedAdminId: chat.assignedAdminId ? String(chat.assignedAdminId) : null,
      assignedAdminName: await liveAgentFirstName(db, chat),
      history: chat.messages ?? [],
    });
    conversationId = chat._id;
  } else {
    conversationId = safeConversationId(body.conversationId);
  }
  const id = String(conversationId);
  if (!ctx.isAdmin && !owner) throw new Error("not your conversation");

  checkConversationRate(id);
  const agent = ctx.isAdmin ? await actingAdmin(socket) : null;
  const sender = ctx.isAdmin ? null : await customerName(socket);
  const now = new Date();
  const message: SupportMessage = {
    _id: new ObjectId(),
    from: ctx.isAdmin ? "admin" : "user",
    authorId,
    authorName: agent ? agent.name : sender?.first ?? "You",
    text,
    createdAt: now,
    readBy: authorId ? [authorId] : [],
    ...(clientMessageId ? { clientMessageId } : {}),
  };

  const post = await appendMessage(chats, conversationId, message, {
    filter: ctx.isAdmin ? { status: { $ne: "resolved" } } : { status: { $ne: "resolved" }, ...owner },
    bumpUpdatedAt: true,
    promoteAgent: agent ?? undefined,
  });
  if (!post) return explainAppendMiss(chats, conversationId, ctx, clientMessageId, text);

  const saved = storedMessage(post, message);
  toConversation(ns, post).emit("support:message", { conversationId: id, message: saved });
  await archiveMessage(archive, conversationId, saved);

  const promoted = !!agent && post.status === "open" && !!post.assignedAdminId && post.assignedAdminId.equals(agent.id);
  if (promoted) {
    toConversation(ns, post).emit("support:status", {
      conversationId: id,
      status: "open",
      assignedAdminId: String(agent!.id),
      assignedAdminName: agent!.name,
    });
  }

  // The conversation reaches the agents' inbox with its first customer
  // message — whether it was just created, opened by an older widget, or
  // left empty from before.
  const customerMessages = (post.messages ?? []).filter((m) => m.from === "user").length;
  if (!ctx.isAdmin && customerMessages === 1) {
    const row = await newConversationRow(db, post, saved, sender);
    ns.to(ADMINS_ROOM).emit("support:new-conversation", { conversationId: id, userFirstName: row.userFirstName, conversation: row });
  }
  ns.to(ADMINS_ROOM).emit("support:conversation-updated", {
    conversationId: id,
    lastMessage: previewOf(saved),
    status: post.status,
    unread: post.unreadCounts?.admin ?? 0,
    updatedAt: post.updatedAt,
    rev: post.rev ?? 0,
    ...(promoted ? { assignedAdminId: String(agent!.id), assignedAdminName: agent!.name } : {}),
  });

  if (!ctx.isAdmin) await maybeAutoAck(ns, chats, archive, post, now);
  return { conversationId: id, messageId: String(message._id) };
}

// Why an append matched nothing — or, for a resend, the original message.
async function explainAppendMiss(
  chats: Collection<SupportChat>,
  conversationId: ObjectId,
  ctx: ConnContext,
  clientMessageId: string | undefined,
  text: string
): Promise<SendResult> {
  const doc = await chats.findOne(
    { _id: conversationId },
    {
      projection: {
        status: 1,
        userId: 1,
        guestSessionId: 1,
        ...(clientMessageId ? { messages: { $elemMatch: { clientMessageId } } } : {}),
      },
      maxTimeMS: WRITE_MAX_TIME_MS,
    }
  );
  if (!doc) throw new Error("conversation not found");
  if (!ctx.isAdmin && !ownsConversation(ctx, doc)) throw new Error("not your conversation");
  const original = clientMessageId ? doc.messages?.[0] : undefined;
  if (original) {
    // A resend of something already stored: acknowledge it, change nothing.
    if (original.text !== text) throw new Error("message id already used for a different message");
    return { conversationId: String(conversationId), messageId: String(original._id), duplicate: true };
  }
  if (doc.status === "resolved") throw new Error("conversation closed — admin must reopen first");
  throw new Error("could not send — try again");
}

// Auto-acknowledgement (templated, NOT LLM-generated). Reassures the customer
// that their message landed before an agent is online; suppressed once an
// agent engages and at most one per 5 minutes. Race-safe: the conditions sit
// in the append itself, so exactly one of any concurrent candidates lands.
async function maybeAutoAck(
  ns: Namespace,
  chats: Collection<SupportChat>,
  archive: Collection<ArchivedMessage>,
  post: SupportChat,
  now: Date
): Promise<void> {
  if (post.assignedAdminId) return;
  const id = String(post._id);
  const isFirstAck = !(post.messages ?? []).some((m) => m.from === "system" && m.kind === "auto");
  if (!checkRateLimit(`support:conv:${id}`, CONVO_APPEND_LIMIT, CONVO_APPEND_WINDOW_MS).ok) return;
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const autoMsg: SupportMessage = {
    _id: new ObjectId(),
    from: "system",
    authorId: null,
    authorName: null,
    text: isFirstAck
      ? "Thanks for reaching out to Majestic Support! 👋 We've got your message — an agent will be with you as soon as possible. In the meantime, sharing a booking reference or a few extra details helps us get back to you faster."
      : "Still here — your message is in our queue and an agent will respond shortly. Thanks for your patience!",
    createdAt: new Date(),
    readBy: [],
    kind: "auto",
  };
  const acked = await appendMessage(chats, post._id, autoMsg, {
    filter: {
      assignedAdminId: null,
      $nor: [{ messages: { $elemMatch: { from: "system", kind: "auto", createdAt: { $gte: fiveMinAgo } } } }],
    },
  });
  if (!acked) return;
  const saved = storedMessage(acked, autoMsg);
  toConversation(ns, acked).emit("support:message", { conversationId: id, message: saved });
  await archiveMessage(archive, post._id, saved);
  // Not sent to the agents' inbox: its preview is what the customer wrote.
}

// ─── Assign / handover ──────────────────────────────────────────────────────

async function handleAssign(ns: Namespace, socket: Socket, payload: unknown): Promise<void> {
  const conversationId = safeConversationId(payloadOf(payload).conversationId);
  const id = String(conversationId);
  const agent = await actingAdmin(socket);
  const { db, chats, archive } = await getCollections();

  for (let attempt = 0; attempt < 2; attempt++) {
    const chat = await chats.findOne(
      { _id: conversationId },
      { projection: { status: 1, assignedAdminId: 1, assignedAdminName: 1 }, maxTimeMS: WRITE_MAX_TIME_MS }
    );
    if (!chat) throw new Error("conversation not found");
    if (chat.status === "resolved") throw new Error("conversation is resolved — reopen before assigning");
    // Same agent: make sure they're in the room, nothing else.
    if (chat.assignedAdminId && chat.assignedAdminId.equals(agent.id)) {
      socket.join(roomFor(id));
      return;
    }

    const previousId = chat.assignedAdminId ?? null;
    const previousName = previousId
      ? (await lookupAdminNames(db, [previousId]).catch(() => new Map<string, PersonName>())).get(String(previousId))?.first ??
        chat.assignedAdminName ??
        "another agent"
      : null;
    checkConversationRate(id);
    const joinedAt = new Date();
    const systemMessage: SupportMessage = {
      _id: new ObjectId(),
      from: "system",
      authorId: null,
      authorName: null,
      text: previousId ? `${agent.name} joined the chat (taking over from ${previousName})` : `${agent.name} joined the chat`,
      kind: previousId ? "handover" : "join",
      createdAt: joinedAt,
      readBy: [],
    };
    // Compare-and-set on the assignee: if someone else took it in between,
    // this write matches nothing and the loop re-reads once.
    const post = await appendMessage(chats, conversationId, systemMessage, {
      filter: { status: { $ne: "resolved" }, assignedAdminId: previousId },
      set: { assignedAdminId: agent.id, assignedAdminName: agent.name, status: "open" },
      bumpUpdatedAt: true,
      assignment: { adminId: agent.id, adminName: agent.name, joinedAt },
    });
    if (!post) continue;

    socket.join(roomFor(id));
    const saved = storedMessage(post, systemMessage);
    toConversation(ns, post).emit("support:status", {
      conversationId: id,
      status: "open",
      assignedAdminId: String(agent.id),
      assignedAdminName: agent.name,
    });
    toConversation(ns, post).emit("support:message", { conversationId: id, message: saved });
    ns.to(ADMINS_ROOM).emit("support:conversation-updated", {
      conversationId: id,
      lastMessage: previewOf(saved),
      assignedAdminId: String(agent.id),
      assignedAdminName: agent.name,
      status: "open",
      unread: post.unreadCounts?.admin ?? 0,
      updatedAt: post.updatedAt,
      rev: post.rev ?? 0,
    });
    await archiveMessage(archive, conversationId, saved);
    await logAudit({
      conversationId,
      actorId: agent.id,
      actorName: agent.name,
      action: previousId ? "handover" : "assign",
      details: previousId ? { previousAdminId: String(previousId), previousAdminName: previousName } : undefined,
    });
    return;
  }
  throw new Error("the conversation changed — try again");
}

// ─── Resolve ─────────────────────────────────────────────────────────────────

async function handleResolve(ns: Namespace, socket: Socket, payload: unknown): Promise<void> {
  const conversationId = safeConversationId(payloadOf(payload).conversationId);
  const id = String(conversationId);
  const agent = await actingAdmin(socket);
  const { chats, archive } = await getCollections();

  checkConversationRate(id);
  const now = new Date();
  const systemMessage: SupportMessage = {
    _id: new ObjectId(),
    from: "system",
    authorId: null,
    authorName: null,
    text: `This conversation was marked resolved by ${agent.name}`,
    kind: "resolve",
    createdAt: now,
    readBy: [],
  };
  // Only the write that actually resolves it adds the line and the audit.
  const post = await appendMessage(chats, conversationId, systemMessage, {
    filter: { status: { $ne: "resolved" } },
    set: { status: "resolved", resolvedAt: now },
    unset: ["activeKey"],
    bumpUpdatedAt: true,
  });
  if (!post) {
    const exists = await chats.findOne({ _id: conversationId }, { projection: { _id: 1 }, maxTimeMS: WRITE_MAX_TIME_MS });
    if (!exists) throw new Error("conversation not found");
    return; // already resolved, no-op
  }

  const saved = storedMessage(post, systemMessage);
  toConversation(ns, post).emit("support:status", { conversationId: id, status: "resolved", resolvedAt: now });
  toConversation(ns, post).emit("support:message", { conversationId: id, message: saved });
  ns.to(ADMINS_ROOM).emit("support:conversation-updated", {
    conversationId: id,
    lastMessage: previewOf(saved),
    status: "resolved",
    resolvedAt: now,
    unread: post.unreadCounts?.admin ?? 0,
    updatedAt: post.updatedAt,
    rev: post.rev ?? 0,
  });
  await archiveMessage(archive, conversationId, saved);
  await logAudit({ conversationId, actorId: agent.id, actorName: agent.name, action: "resolve" });
}

// ─── Reopen ──────────────────────────────────────────────────────────────────

async function handleReopen(ns: Namespace, socket: Socket, payload: unknown): Promise<void> {
  const conversationId = safeConversationId(payloadOf(payload).conversationId);
  const id = String(conversationId);
  const agent = await actingAdmin(socket);
  const { chats, archive } = await getCollections();

  const chat = await chats.findOne(
    { _id: conversationId },
    { projection: { status: 1, userId: 1, guestSessionId: 1 }, maxTimeMS: WRITE_MAX_TIME_MS }
  );
  if (!chat) throw new Error("conversation not found");
  if (chat.status !== "resolved") throw new Error("conversation is not resolved");

  checkConversationRate(id);
  const now = new Date();
  const systemMessage: SupportMessage = {
    _id: new ObjectId(),
    from: "system",
    authorId: null,
    authorName: null,
    text: `${agent.name} reopened this conversation`,
    kind: "reopen",
    createdAt: now,
    readBy: [],
  };
  const ownerKey = ownerKeyOfChat(chat);
  let post: SupportChat | null;
  try {
    post = await appendMessage(chats, conversationId, systemMessage, {
      filter: { status: "resolved" },
      set: {
        status: "open",
        resolvedAt: null,
        assignedAdminId: agent.id,
        assignedAdminName: agent.name,
        ...(ownerKey ? { activeKey: ownerKey } : {}),
      },
      bumpUpdatedAt: true,
      assignment: { adminId: agent.id, adminName: agent.name, joinedAt: now },
    });
  } catch (err) {
    // The customer already has another open conversation: one per customer.
    if ((err as { code?: number }).code === 11000) {
      throw new Error("this customer already has an open conversation — continue there");
    }
    throw err;
  }
  if (!post) throw new Error("conversation is not resolved");

  socket.join(roomFor(id));
  const saved = storedMessage(post, systemMessage);
  toConversation(ns, post).emit("support:status", {
    conversationId: id,
    status: "open",
    assignedAdminId: String(agent.id),
    assignedAdminName: agent.name,
  });
  toConversation(ns, post).emit("support:message", { conversationId: id, message: saved });
  ns.to(ADMINS_ROOM).emit("support:conversation-updated", {
    conversationId: id,
    lastMessage: previewOf(saved),
    status: "open",
    resolvedAt: null,
    assignedAdminId: String(agent.id),
    assignedAdminName: agent.name,
    unread: post.unreadCounts?.admin ?? 0,
    updatedAt: post.updatedAt,
    rev: post.rev ?? 0,
  });
  await archiveMessage(archive, conversationId, saved);
  await logAudit({ conversationId, actorId: agent.id, actorName: agent.name, action: "reopen" });
}

// ─── Rate ────────────────────────────────────────────────────────────────────

async function handleRate(ns: Namespace, socket: Socket, payload: unknown): Promise<void> {
  const ctx = ctxOf(socket);
  if (ctx.isAdmin) throw new Error("only the user can rate");
  const body = payloadOf(payload);
  const stars = typeof body.stars === "number" || typeof body.stars === "string" ? Number(body.stars) : NaN;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new Error("stars must be 1..5");
  }
  if (body.comment != null && typeof body.comment !== "string") throw new Error("invalid comment");
  const comment = (typeof body.comment === "string" ? body.comment : "").trim().slice(0, RATING_COMMENT_MAX) || null;

  const conversationId = safeConversationId(body.conversationId);
  const id = String(conversationId);
  const owner = ownerFilterOf(ctx);
  if (!owner) throw new Error("not your conversation");
  const { chats } = await getCollections();

  const rating: SupportRating = { stars, comment, ratedAt: new Date() };
  // Owner and state in the write: a reopen that lands first makes this fail.
  const post = await chats.findOneAndUpdate(
    { _id: conversationId, status: "resolved", ...owner },
    { $set: { rating, updatedAt: rating.ratedAt }, $inc: { rev: 1 } },
    { returnDocument: "after", projection: { rev: 1, userId: 1, guestSessionId: 1 }, maxTimeMS: WRITE_MAX_TIME_MS }
  );
  if (!post) {
    const doc = await chats.findOne(
      { _id: conversationId },
      { projection: { status: 1, userId: 1, guestSessionId: 1 }, maxTimeMS: WRITE_MAX_TIME_MS }
    );
    if (!doc) throw new Error("conversation not found");
    if (!ownsConversation(ctx, doc)) throw new Error("not your conversation");
    throw new Error("only resolved conversations can be rated");
  }

  toConversation(ns, post).emit("support:rated", { conversationId: id, rating });
  ns.to(ADMINS_ROOM).emit("support:conversation-updated", { conversationId: id, rating, rev: post.rev ?? 0 });
  const name = await customerName(socket);
  await logAudit({
    conversationId,
    actorId: safeUserIdFromJwt(ctx.jwt),
    actorName: name?.first ?? null,
    action: "rate",
    details: { stars, hasComment: !!comment },
  });
}

// ─── Read receipts ───────────────────────────────────────────────────────────

async function handleRead(ns: Namespace, socket: Socket, payload: unknown): Promise<void> {
  const ctx = ctxOf(socket);
  const body = payloadOf(payload);
  const conversationId = safeConversationId(body.conversationId);
  const id = String(conversationId);
  const lastMessageId =
    typeof body.lastMessageId === "string" && OBJECT_ID_RE.test(body.lastMessageId) ? body.lastMessageId : undefined;
  const { chats } = await getCollections();

  if (!ctx.isAdmin) {
    // Customers can only mark their own conversation read.
    const owner = ownerFilterOf(ctx);
    if (!owner) return;
    const result = await chats.updateOne(
      { _id: conversationId, ...owner },
      { $set: { "unreadCounts.user": 0 } },
      { maxTimeMS: WRITE_MAX_TIME_MS }
    );
    if (result.matchedCount === 0) return;
    socket.to(roomFor(id)).emit("support:read-update", { conversationId: id, by: "user", lastMessageId });
    return;
  }

  // Agents: read up to a message they have on screen, named by (seq,
  // messageId) and accepted only if that message is in this conversation.
  // The position only moves forward ($max), so a late, older receipt can't
  // bring unread back, and the count stays exact past 500 messages.
  const seq = typeof body.seq === "number" && Number.isInteger(body.seq) && body.seq >= 0 ? body.seq : null;
  const messageId = typeof body.messageId === "string" && OBJECT_ID_RE.test(body.messageId) ? new ObjectId(body.messageId) : null;
  const rev = { $add: [{ $ifNull: ["$rev", 0] }, 1] };
  let post: SupportChat | null;
  if (seq !== null && messageId) {
    post = await chats.findOneAndUpdate(
      { _id: conversationId, messages: { $elemMatch: { _id: messageId, seq } } },
      [
        {
          $set: {
            readUserIdx: {
              admin: {
                $max: [
                  { $ifNull: ["$readUserIdx.admin", 0] },
                  {
                    $ifNull: [
                      {
                        $max: {
                          $map: {
                            input: {
                              $filter: {
                                input: "$messages",
                                cond: { $and: [{ $eq: ["$$this.from", "user"] }, { $lte: ["$$this.seq", seq] }] },
                              },
                            },
                            in: "$$this.userIdx",
                          },
                        },
                      },
                      0,
                    ],
                  },
                ],
              },
            },
            rev,
          },
        },
        {
          $set: {
            "unreadCounts.admin": { $max: [0, { $subtract: [{ $ifNull: ["$userMsgs", 0] }, "$readUserIdx.admin"] }] },
          },
        },
      ],
      { returnDocument: "after", projection: { rev: 1, unreadCounts: 1 }, maxTimeMS: WRITE_MAX_TIME_MS }
    );
    if (!post) return; // not a message of this conversation: ignored
  } else {
    // Consoles from before read positions (or a thread with no positions
    // yet): everything is read, as before.
    post = await chats.findOneAndUpdate(
      { _id: conversationId },
      [{ $set: { readUserIdx: { admin: { $ifNull: ["$userMsgs", 0] } }, "unreadCounts.admin": 0, rev } }],
      { returnDocument: "after", projection: { rev: 1, unreadCounts: 1 }, maxTimeMS: WRITE_MAX_TIME_MS }
    );
    if (!post) return;
  }
  socket.to(roomFor(id)).emit("support:read-update", { conversationId: id, by: "admin", lastMessageId });
  ns.to(ADMINS_ROOM).emit("support:conversation-updated", {
    conversationId: id,
    unread: post.unreadCounts?.admin ?? 0,
    rev: post.rev ?? 0,
  });
}

// ─── History ────────────────────────────────────────────────────────────────

// Authorize → join the room → read, so nothing sent in between is missed.
// A customer's read carries the ownership condition itself: a sign-in claim
// that lands mid-request makes it return nothing.
async function handleFetchHistory(socket: Socket, payload: unknown): Promise<void> {
  const ctx = ctxOf(socket);
  const conversationId = safeConversationId(payloadOf(payload).conversationId);
  const id = String(conversationId);
  const { chats, archive } = await getCollections();

  let filter: Document = { _id: conversationId };
  if (!ctx.isAdmin) {
    const owner = ownerFilterOf(ctx);
    if (!owner) throw new Error("forbidden");
    filter = { _id: conversationId, ...owner };
    const allowed = await chats.findOne(filter, { projection: { _id: 1 }, maxTimeMS: WRITE_MAX_TIME_MS });
    if (!allowed) throw new Error("forbidden");
  }
  socket.join(roomFor(id));
  const chat = await chats.findOne(filter, { maxTimeMS: WRITE_MAX_TIME_MS });
  if (!chat) {
    socket.leave(roomFor(id));
    throw new Error(ctx.isAdmin ? "conversation not found" : "forbidden");
  }

  // The ring is in commit order; anything older than it lives only in the
  // archive and comes first.
  const live = chat.messages ?? [];
  const inRing = new Set(live.map((m) => String(m._id)));
  const archived = await archive.find({ conversationId }, { maxTimeMS: WRITE_MAX_TIME_MS }).toArray();
  const older = archived
    .map((a) => a.message)
    .filter((m) => !inRing.has(String(m._id)))
    .sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  socket.emit("support:history", { conversationId: id, messages: [...older, ...live] });
}
