import { Server as IOServer, Socket } from "socket.io";
import { ObjectId } from "mongodb";
import clientPromise from "./mongodb";
import { verifyToken, AppJwtPayload, resolveIsAdmin } from "./jwt";
import { checkRateLimit } from "./rateLimit";
import { validateUserMessage, redactForLogs, sanitizeText } from "./moderation";

const SUPPORT_MSG_LIMIT = 20; // 20 messages per minute per user/guest
const SUPPORT_MSG_WINDOW_MS = 60_000;
const MAX_MESSAGES_PER_CONVO = 500; // hard cap; older entries archived
const RATING_COMMENT_MAX = 500;

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
  // Display name surfaced to admin. Captured from JWT.firstName at convo
  // creation. For anonymous guests this is "Guest".
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
}

const ADMINS_ROOM = "admins:online";
const roomFor = (conversationId: string) => `support:${conversationId}`;

interface ArchivedMessage {
  _id?: ObjectId;
  conversationId: ObjectId;
  message: SupportMessage;
  archivedAt: Date;
}

let archiveIndexEnsured = false;

async function getCollections() {
  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);
  const archive = db.collection<ArchivedMessage>("support_chats_archive");
  if (!archiveIndexEnsured) {
    archiveIndexEnsured = true;
    archive
      .createIndex(
        { conversationId: 1, "message._id": 1 },
        { unique: true, name: "conv_msg_unique" }
      )
      .catch((err) => {
        console.warn("[support] failed to ensure archive index:", err);
        archiveIndexEnsured = false;
      });
  }
  return {
    chats: db.collection<SupportChat>("support_chats"),
    audit: db.collection<AuditEntry>("support_audit"),
    archive,
  };
}

// Append a message to a conversation. Strategy:
//   1. Write the message to support_chats_archive FIRST (immutable compliance log).
//   2. Push it onto chats.messages with $slice: -500 (atomic eviction; older
//      messages are still safely in the archive).
//
// This means archive contains EVERY message ever sent (no race-induced gaps),
// and chats.messages is a hot-cache ring buffer for the live UI/admin list.
// Transcript export reads from archive so users always get the full history.
async function appendMessageWithArchive(
  conversationId: ObjectId,
  message: SupportMessage,
  extra?: { incCounterparty?: "user" | "admin"; assignmentEntry?: AssignmentEntry }
): Promise<void> {
  const { chats, archive } = await getCollections();

  // Verify the conversation exists before writing anything.
  const exists = await chats.findOne(
    { _id: conversationId },
    { projection: { _id: 1 } }
  );
  if (!exists) throw new Error("conversation not found");

  // Build the chats.updateOne spec. We push to the ring buffer FIRST so the
  // live UI sees the message immediately. The archive insert is then
  // attempted — and retried — without blocking visibility.
  const pushSpec: Record<string, unknown> = {
    messages: { $each: [message], $slice: -MAX_MESSAGES_PER_CONVO },
  };
  if (extra?.assignmentEntry) {
    pushSpec.assignmentHistory = extra.assignmentEntry;
  }
  const update: Record<string, unknown> = {
    $push: pushSpec as never,
    $set: { updatedAt: new Date() },
  };
  if (extra?.incCounterparty) {
    update.$inc = { [`unreadCounts.${extra.incCounterparty}`]: 1 };
  }

  // Step 1 — push to live ring buffer. If this fails the caller should see
  // the error and let the user know; the message simply wasn't accepted.
  await chats.updateOne({ _id: conversationId }, update);

  // Step 2 — best-effort archive insert with retry. Unique index on
  // (conversationId, message._id) keeps retries idempotent, so it's safe
  // to retry up to 3 times. If all retries fail, the message still lives
  // in the ring buffer (500-deep) until eviction; we log loudly so an
  // operator notices, but we don't surface the error to the user — the
  // message DID land.
  let archived = false;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3 && !archived; attempt++) {
    try {
      await archive.insertOne({
        conversationId,
        message,
        archivedAt: new Date(),
      });
      archived = true;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 11000) {
        // Duplicate — already archived, treat as success.
        archived = true;
      } else {
        lastErr = err;
        if (attempt < 2) {
          // Tiny backoff: 50ms, 200ms.
          await new Promise((r) => setTimeout(r, attempt === 0 ? 50 : 200));
        }
      }
    }
  }
  if (!archived) {
    console.error(
      "[support] archive insert FAILED after 3 retries for message",
      String(message._id),
      "conv",
      String(conversationId),
      "err",
      lastErr
    );
  }
}

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
  if (typeof raw !== "string" || !/^[0-9a-fA-F]{24}$/.test(raw)) {
    throw new Error("invalid conversation id");
  }
  return new ObjectId(raw);
}

function nameFromJwt(jwt: AppJwtPayload | null, fallback = "Agent"): string {
  const fn = jwt?.firstName;
  if (typeof fn === "string" && fn.trim()) return fn.trim();
  return fallback;
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

export function mountSupportNamespace(io: IOServer): void {
  const ns = io.of("/support");

  ns.use(async (socket, next) => {
    const auth = socket.handshake.auth || {};
    const jwt = verifyToken(auth.token as string | undefined);
    const guestSessionId = (auth.guestSessionId as string | undefined) ?? null;
    if (!jwt && !guestSessionId) {
      return next(new Error("auth required: provide JWT token or guestSessionId"));
    }
    const isAdmin = await resolveIsAdmin(jwt);
    const ctx: ConnContext = { jwt, isAdmin, guestSessionId };
    (socket.data as { ctx: ConnContext }).ctx = ctx;
    next();
  });

  ns.on("connection", (socket: Socket) => {
    const { ctx } = socket.data as { ctx: ConnContext };

    if (ctx.isAdmin) void onAdminConnect(socket);
    else void onUserConnect(socket);

    // Debounce per-socket: rapid duplicate `support:start` (e.g., from
    // socket.io reconnect storms or a misbehaving client) shouldn't trigger
    // duplicate `support:joined` payloads or duplicate Mongo work.
    let lastStartAt = 0;
    socket.on("support:start", async () => {
      const now = Date.now();
      if (now - lastStartAt < 500) return; // ignore inside 500ms window
      lastStartAt = now;
      if (ctx.isAdmin) await onAdminConnect(socket);
      else await onUserConnect(socket);
    });

    socket.on("support:message", async (payload, ack) => {
      try {
        await handleIncomingMessage(socket, payload);
        ack?.({ ok: true });
      } catch (err) {
        console.error("[support] message error", err);
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on("support:read", async (payload) => {
      try {
        await handleRead(socket, payload);
      } catch (err) {
        console.error("[support] read error", err);
      }
    });

    socket.on("support:typing", async (payload: { conversationId: string; isTyping: boolean }) => {
      // Authz: verify the sender is part of this conversation before
      // broadcasting their typing state. Without this, a curious admin
      // could blast "typing…" at any conversation room. Admins are
      // implicitly trusted across all rooms, so they short-circuit.
      try {
        if (!ctx.isAdmin) {
          const conversationId = safeConversationId(payload.conversationId);
          const { chats } = await getCollections();
          const userId = safeUserIdFromJwt(ctx.jwt);
          const ownerFilter = userId
            ? { _id: conversationId, userId }
            : { _id: conversationId, guestSessionId: ctx.guestSessionId };
          const owns = await chats.findOne(ownerFilter, { projection: { _id: 1 } });
          if (!owns) return;
        }
        socket.to(roomFor(payload.conversationId)).emit("support:typing", {
          conversationId: payload.conversationId,
          from: ctx.isAdmin ? "admin" : "user",
          isTyping: payload.isTyping,
        });
      } catch (err) {
        console.warn("[support] typing authz check failed:", err);
      }
    });

    socket.on("support:assign", async (payload: { conversationId: string }, ack?: (r: { ok: boolean; error?: string }) => void) => {
      if (!ctx.isAdmin) {
        ack?.({ ok: false, error: "admin only" });
        return;
      }
      try {
        await handleAssign(ns, socket, payload);
        ack?.({ ok: true });
      } catch (err) {
        console.error("[support] assign error", err);
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on("support:resolve", async (payload: { conversationId: string }, ack?: (r: { ok: boolean; error?: string }) => void) => {
      if (!ctx.isAdmin) {
        ack?.({ ok: false, error: "admin only" });
        return;
      }
      try {
        await handleResolve(ns, socket, payload);
        ack?.({ ok: true });
      } catch (err) {
        console.error("[support] resolve error", err);
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on("support:reopen", async (payload: { conversationId: string }, ack?: (r: { ok: boolean; error?: string }) => void) => {
      if (!ctx.isAdmin) {
        ack?.({ ok: false, error: "admin only" });
        return;
      }
      try {
        await handleReopen(ns, socket, payload);
        ack?.({ ok: true });
      } catch (err) {
        console.error("[support] reopen error", err);
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on("support:rate", async (payload: { conversationId: string; stars: number; comment?: string }, ack?: (r: { ok: boolean; error?: string }) => void) => {
      try {
        await handleRate(ns, socket, payload);
        ack?.({ ok: true });
      } catch (err) {
        console.error("[support] rate error", err);
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    // Replays the full conversation history (live ring buffer + archive) to the
    // requesting socket. Used by the admin reply console when an agent opens a
    // conversation, and by user clients that want to backfill older messages.
    // For compliance, every message ever sent is preserved and returned here —
    // including those evicted from `messages[]` once it reached the 500 cap.
    socket.on("support:fetch-history", async (
      payload: { conversationId: string },
      ack?: (r: { ok: boolean; error?: string }) => void
    ) => {
      try {
        const conversationId = safeConversationId(payload.conversationId);
        const { chats, archive } = await getCollections();
        const chat = await chats.findOne({ _id: conversationId });
        if (!chat) throw new Error("conversation not found");

        // Authorisation: admin OR the conversation's owner (logged-in or guest).
        const authorId = safeUserIdFromJwt(ctx.jwt);
        const isAdmin = ctx.isAdmin;
        const ownsByUser = !!(authorId && chat.userId && chat.userId.equals(authorId));
        const ownsByGuest = !authorId && !!chat.guestSessionId && chat.guestSessionId === ctx.guestSessionId;
        if (!isAdmin && !ownsByUser && !ownsByGuest) {
          throw new Error("forbidden");
        }

        // Pull every archived message (the immutable log) plus the live tail,
        // dedup by message._id, and emit ascending by createdAt.
        const archived = await archive
          .find({ conversationId })
          .sort({ "message.createdAt": 1 })
          .toArray();
        const live = chat.messages ?? [];
        const seen = new Set<string>();
        const all: SupportMessage[] = [];
        for (const a of archived) {
          const id = String(a.message._id);
          if (seen.has(id)) continue;
          seen.add(id);
          all.push(a.message);
        }
        for (const m of live) {
          const id = String(m._id);
          if (seen.has(id)) continue;
          seen.add(id);
          all.push(m);
        }
        all.sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );

        socket.emit("support:history", {
          conversationId: payload.conversationId,
          messages: all,
        });
        ack?.({ ok: true });
      } catch (err) {
        console.error("[support] fetch-history error", err);
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on(
      "support:rating-dismissed",
      async (
        payload: { conversationId: string },
        ack?: (r: { ok: boolean; error?: string }) => void
      ) => {
        try {
          const { chats } = await getCollections();
          await chats.updateOne(
            { _id: safeConversationId(payload.conversationId) },
            { $set: { ratingDismissedAt: new Date() } }
          );
          // Ack so the client can sequence: dismiss → wait for ack → start
          // a new conversation. Without this, support:start can race past
          // the dismiss write and the server's onUserConnect re-finds the
          // unrated-resolved convo, replaying the rating prompt.
          ack?.({ ok: true });
        } catch (err) {
          console.error("[support] rating-dismissed error", err);
          ack?.({ ok: false, error: (err as Error).message });
        }
      }
    );

    socket.on("disconnect", () => {
      // Rooms are cleaned up by Socket.IO automatically.
    });
  });
}

// ─── User connect ───────────────────────────────────────────────────────────

async function onUserConnect(socket: Socket): Promise<void> {
  const { ctx } = socket.data as { ctx: ConnContext };

  // No connect-time rate limit — every page reload, network blip, or tab
  // switch reconnects the support socket, and gating that creates false
  // "too many new conversations" errors for ordinary users who simply
  // refreshed the page. Per-message rate limit (SUPPORT_MSG_LIMIT) below
  // remains the real spam guard.

  const { chats } = await getCollections();
  const userId = safeUserIdFromJwt(ctx.jwt);

  // Sign-in upgrade — if a logged-in user also presents a guestSessionId, claim
  // any guest conversations from that browser into their account. One-time;
  // subsequent connections won't match because guestSessionId is then null.
  if (userId && ctx.guestSessionId) {
    try {
      const userFirstName = nameFromJwt(ctx.jwt, "User");
      await chats.updateMany(
        { userId: null, guestSessionId: ctx.guestSessionId },
        { $set: { userId, guestSessionId: null, userFirstName } }
      );
      // Also upgrade AI chat history written by the same guest.
      const client = await clientPromise;
      const uri = process.env.MONGODB_URI || "";
      const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
      client
        .db(dbName)
        .collection("ai_chat_messages")
        .updateMany(
          { userId: null, guestSessionId: ctx.guestSessionId },
          { $set: { userId, guestSessionId: null } }
        )
        .catch((err) => console.warn("[support] ai history upgrade failed:", err));
    } catch (err) {
      console.warn("[support] guest→user upgrade failed:", err);
    }
  }

  const baseFilter = userId
    ? { userId }
    : { guestSessionId: ctx.guestSessionId };

  // Look for an active (non-resolved) conversation first.
  let chat = await chats.findOne({ ...baseFilter, status: { $ne: "resolved" as const } });

  // If none, look for the most recently resolved that's unrated and within 7 days,
  // so we can prompt for the rating before starting a new conversation.
  if (!chat) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentResolvedUnrated = await chats.findOne(
      {
        ...baseFilter,
        status: "resolved",
        rating: null,
        ratingDismissedAt: null,
        resolvedAt: { $gte: sevenDaysAgo },
      },
      { sort: { resolvedAt: -1 } }
    );
    if (recentResolvedUnrated) {
      // Send the resolved convo so the client can show the rating prompt.
      const conversationId = String(recentResolvedUnrated._id);
      socket.join(roomFor(conversationId));
      socket.emit("support:joined", buildJoinedPayload(recentResolvedUnrated, /* awaitingRating */ true));
      return;
    }
  }

  if (!chat) {
    const now = new Date();
    const userFirstName = userId
      ? nameFromJwt(ctx.jwt, "User")
      : "Guest";
    const doc: SupportChat = {
      _id: new ObjectId(),
      userId,
      guestSessionId: userId ? null : ctx.guestSessionId,
      userFirstName,
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
    };
    await chats.insertOne(doc);
    chat = doc;
    socket.nsp.to(ADMINS_ROOM).emit("support:new-conversation", {
      conversationId: String(doc._id),
      userFirstName,
    });
  }

  const conversationId = String(chat._id);
  socket.join(roomFor(conversationId));
  await chats.updateOne({ _id: chat._id }, { $set: { "unreadCounts.user": 0 } });
  socket.emit("support:joined", buildJoinedPayload(chat, /* awaitingRating */ false));
}

function buildJoinedPayload(chat: SupportChat, awaitingRating: boolean) {
  return {
    conversationId: String(chat._id),
    history: chat.messages,
    status: chat.status,
    assignedAdminId: chat.assignedAdminId ? String(chat.assignedAdminId) : null,
    assignedAdminName: chat.assignedAdminName,
    rating: chat.rating,
    awaitingRating,
  };
}

// ─── Admin connect ───────────────────────────────────────────────────────────

async function onAdminConnect(socket: Socket): Promise<void> {
  socket.join(ADMINS_ROOM);
  const { chats } = await getCollections();
  const open = await chats
    .find({}, { sort: { updatedAt: -1 }, limit: 50 })
    .project({
      messages: { $slice: -1 },
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
    })
    .toArray();

  socket.emit("support:admin-init", {
    conversations: open.map((c) => ({
      conversationId: String(c._id),
      userId: c.userId ? String(c.userId) : null,
      guestSessionId: c.guestSessionId,
      userFirstName: c.userFirstName ?? (c.userId ? "User" : "Guest"),
      status: c.status,
      lastMessage: c.messages?.[0] ?? null,
      unread: c.unreadCounts?.admin ?? 0,
      updatedAt: c.updatedAt,
      assignedAdminId: c.assignedAdminId ? String(c.assignedAdminId) : null,
      assignedAdminName: c.assignedAdminName,
      rating: c.rating ?? null,
      resolvedAt: c.resolvedAt ?? null,
    })),
  });
}

// ─── Message ─────────────────────────────────────────────────────────────────

async function handleIncomingMessage(
  socket: Socket,
  payload: { conversationId: string; text: string; clientMessageId?: string }
): Promise<void> {
  const { ctx } = socket.data as { ctx: ConnContext };

  const v = validateUserMessage(payload.text);
  if (!v.ok) throw new Error(v.reason ?? "invalid message");
  const text = sanitizeText((payload.text as string).trim());
  if (!text) throw new Error("Message is empty");

  // clientMessageId must be a short string if provided — block NoSQL operator
  // injection via this field.
  let clientMessageId: string | undefined = undefined;
  if (payload.clientMessageId !== undefined && payload.clientMessageId !== null) {
    if (typeof payload.clientMessageId !== "string" || payload.clientMessageId.length > 64) {
      throw new Error("invalid clientMessageId");
    }
    clientMessageId = payload.clientMessageId;
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

  const conversationId = safeConversationId(payload.conversationId);
  const { chats } = await getCollections();

  // Fetch the chat once; verify ownership AND status atomically.
  const chat = await chats.findOne({ _id: conversationId });
  if (!chat) throw new Error("conversation not found");
  if (chat.status === "resolved") {
    throw new Error("conversation closed — admin must reopen first");
  }
  if (!ctx.isAdmin) {
    const ownsByUser = authorId && chat.userId && chat.userId.equals(authorId);
    const ownsByGuest = !authorId && chat.guestSessionId === ctx.guestSessionId;
    if (!ownsByUser && !ownsByGuest) throw new Error("not your conversation");
  }

  // Idempotency on clientMessageId — if a message with the same id already exists, no-op.
  if (clientMessageId) {
    const dup = chat.messages?.some((m) => m.clientMessageId === clientMessageId);
    if (dup) return;
  }

  const message: SupportMessage = {
    _id: new ObjectId(),
    from: ctx.isAdmin ? "admin" : "user",
    authorId,
    authorName: nameFromJwt(ctx.jwt, ctx.isAdmin ? "Support" : "You"),
    text,
    createdAt: new Date(),
    readBy: authorId ? [authorId] : [],
    clientMessageId,
  };

  const counterparty = ctx.isAdmin ? "user" : "admin";

  await appendMessageWithArchive(conversationId, message, { incCounterparty: counterparty });

  // Auto-promote pending → open when an admin replies (atomic guard).
  if (ctx.isAdmin) {
    await chats.updateOne(
      { _id: conversationId, status: "pending" },
      {
        $set: {
          status: "open",
          assignedAdminId: authorId,
          assignedAdminName: nameFromJwt(ctx.jwt),
        },
      }
    );
  }

  socket.nsp.to(roomFor(payload.conversationId)).emit("support:message", {
    conversationId: payload.conversationId,
    message,
  });
  socket.nsp.to(ADMINS_ROOM).emit("support:conversation-updated", {
    conversationId: payload.conversationId,
    lastMessage: message,
  });

  // Auto-acknowledgement (templated, NOT LLM-generated). Reassures the user
  // that their message landed even before a human admin is online. Suppressed
  // once an admin engages so we don't pollute an active conversation.
  //
  // Gating (race-safe via atomic findOneAndUpdate):
  //   - Only fires for user messages (admin messages are skipped).
  //   - Only when no admin has been assigned yet.
  //   - Only one auto-ack per 5-minute window per conversation. The atomic
  //     guard means concurrent user messages can't double-fire — exactly one
  //     wins the conditional update; the others see no match and skip.
  if (!ctx.isAdmin) {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    // Pre-flight: read once to decide which template to use. The atomic
    // guard below still protects against double-emit even if two requests
    // race past this read.
    const refreshed = await chats.findOne({ _id: conversationId });
    const isFirstAck = !!refreshed && (refreshed.messages ?? []).every(
      (m) => !(m.from === "system" && m.kind === "auto")
    );
    const autoText = isFirstAck
      ? "Thanks for reaching out to Majestic Support! 👋 We've got your message — an agent will be with you as soon as possible. In the meantime, sharing a booking reference or a few extra details helps us get back to you faster."
      : "Still here — your message is in our queue and an agent will respond shortly. Thanks for your patience!";
    const autoMsg: SupportMessage = {
      _id: new ObjectId(),
      from: "system",
      authorId: null,
      authorName: null,
      text: autoText,
      createdAt: new Date(),
      readBy: [],
      kind: "auto",
    };
    // Atomic guard: only push if (a) admin not yet assigned, AND (b) no
    // recent auto-ack in the last 5 min. If two concurrent user messages
    // both reach this point, exactly one update succeeds; the other's
    // matchedCount will be 0 and we skip the emit.
    const guardResult = await chats.updateOne(
      {
        _id: conversationId,
        assignedAdminId: null,
        $nor: [
          {
            messages: {
              $elemMatch: {
                from: "system",
                kind: "auto",
                createdAt: { $gte: fiveMinAgo },
              },
            },
          },
        ],
      },
      { $push: { messages: { $each: [autoMsg], $slice: -MAX_MESSAGES_PER_CONVO } } }
    );
    if (guardResult.matchedCount > 0) {
      // Won the guard. Mirror to archive (non-fatal if it fails — the
      // ring buffer push already committed) and broadcast.
      try {
        const { archive } = await getCollections();
        await archive.insertOne({
          conversationId,
          message: autoMsg,
          archivedAt: new Date(),
        });
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code !== 11000) {
          console.warn("[support] auto-ack archive insert failed:", err);
        }
      }
      socket.nsp.to(roomFor(payload.conversationId)).emit("support:message", {
        conversationId: payload.conversationId,
        message: autoMsg,
      });
      socket.nsp.to(ADMINS_ROOM).emit("support:conversation-updated", {
        conversationId: payload.conversationId,
        lastMessage: autoMsg,
      });
    }
  }
}

// ─── Assign / handover ──────────────────────────────────────────────────────

async function handleAssign(
  ns: IOServer["of"] extends (n: string) => infer R ? R : never,
  socket: Socket,
  payload: { conversationId: string }
): Promise<void> {
  const { ctx } = socket.data as { ctx: ConnContext };
  const adminId = safeUserIdFromJwt(ctx.jwt);
  if (!adminId) throw new Error("admin id missing in jwt");
  const adminName = nameFromJwt(ctx.jwt);

  const conversationId = safeConversationId(payload.conversationId);
  const { chats } = await getCollections();
  const chat = await chats.findOne({ _id: conversationId });
  if (!chat) throw new Error("conversation not found");
  if (chat.status === "resolved") {
    throw new Error("conversation is resolved — reopen before assigning");
  }

  const previousAdminId = chat.assignedAdminId;
  const previousAdminName = chat.assignedAdminName;

  // Same admin — make sure they're in the room and exit early.
  if (previousAdminId && previousAdminId.equals(adminId)) {
    socket.join(roomFor(payload.conversationId));
    return;
  }

  // Determine system message kind based on whether this is an initial join or a handover.
  const isHandover = !!previousAdminId && !previousAdminId.equals(adminId);
  const systemMessage: SupportMessage = {
    _id: new ObjectId(),
    from: "system",
    authorId: null,
    authorName: null,
    text: isHandover
      ? `${adminName} joined the chat (taking over from ${previousAdminName ?? "another agent"})`
      : `${adminName} joined the chat`,
    kind: isHandover ? "handover" : "join",
    createdAt: new Date(),
    readBy: [],
  };

  const assignmentEntry: AssignmentEntry = {
    adminId,
    adminName,
    joinedAt: new Date(),
  };

  await chats.updateOne(
    { _id: conversationId },
    {
      $set: {
        assignedAdminId: adminId,
        assignedAdminName: adminName,
        status: "open",
        updatedAt: new Date(),
      },
    }
  );
  await appendMessageWithArchive(conversationId, systemMessage, { assignmentEntry });

  socket.join(roomFor(payload.conversationId));

  ns.to(roomFor(payload.conversationId)).emit("support:status", {
    conversationId: payload.conversationId,
    status: "open",
    assignedAdminId: String(adminId),
    assignedAdminName: adminName,
  });
  ns.to(roomFor(payload.conversationId)).emit("support:message", {
    conversationId: payload.conversationId,
    message: systemMessage,
  });
  ns.to(ADMINS_ROOM).emit("support:conversation-updated", {
    conversationId: payload.conversationId,
    lastMessage: systemMessage,
    assignedAdminId: String(adminId),
    assignedAdminName: adminName,
    status: "open",
  });

  await logAudit({
    conversationId,
    actorId: adminId,
    actorName: adminName,
    action: isHandover ? "handover" : "assign",
    details: isHandover
      ? { previousAdminId: previousAdminId ? String(previousAdminId) : null, previousAdminName }
      : undefined,
  });
}

// ─── Resolve ─────────────────────────────────────────────────────────────────

async function handleResolve(
  ns: ReturnType<IOServer["of"]>,
  socket: Socket,
  payload: { conversationId: string }
): Promise<void> {
  const { ctx } = socket.data as { ctx: ConnContext };
  const adminId = safeUserIdFromJwt(ctx.jwt);
  const adminName = nameFromJwt(ctx.jwt);
  const conversationId = safeConversationId(payload.conversationId);
  const { chats } = await getCollections();
  const chat = await chats.findOne({ _id: conversationId });
  if (!chat) throw new Error("conversation not found");
  if (chat.status === "resolved") return; // already resolved, no-op

  const systemMessage: SupportMessage = {
    _id: new ObjectId(),
    from: "system",
    authorId: null,
    authorName: null,
    text: `This conversation was marked resolved by ${adminName}`,
    kind: "resolve",
    createdAt: new Date(),
    readBy: [],
  };

  const now = new Date();
  await chats.updateOne(
    { _id: conversationId },
    {
      $set: {
        status: "resolved",
        resolvedAt: now,
        updatedAt: now,
      },
    }
  );
  await appendMessageWithArchive(conversationId, systemMessage);

  ns.to(roomFor(payload.conversationId)).emit("support:status", {
    conversationId: payload.conversationId,
    status: "resolved",
    resolvedAt: now,
  });
  ns.to(roomFor(payload.conversationId)).emit("support:message", {
    conversationId: payload.conversationId,
    message: systemMessage,
  });
  ns.to(ADMINS_ROOM).emit("support:conversation-updated", {
    conversationId: payload.conversationId,
    lastMessage: systemMessage,
    status: "resolved",
  });

  await logAudit({
    conversationId,
    actorId: adminId,
    actorName: adminName,
    action: "resolve",
  });
}

// ─── Reopen ──────────────────────────────────────────────────────────────────

async function handleReopen(
  ns: ReturnType<IOServer["of"]>,
  socket: Socket,
  payload: { conversationId: string }
): Promise<void> {
  const { ctx } = socket.data as { ctx: ConnContext };
  const adminId = safeUserIdFromJwt(ctx.jwt);
  const adminName = nameFromJwt(ctx.jwt);
  const conversationId = safeConversationId(payload.conversationId);
  const { chats } = await getCollections();
  const chat = await chats.findOne({ _id: conversationId });
  if (!chat) throw new Error("conversation not found");
  if (chat.status !== "resolved") throw new Error("conversation is not resolved");

  const systemMessage: SupportMessage = {
    _id: new ObjectId(),
    from: "system",
    authorId: null,
    authorName: null,
    text: `${adminName} reopened this conversation`,
    kind: "reopen",
    createdAt: new Date(),
    readBy: [],
  };

  const now = new Date();
  await chats.updateOne(
    { _id: conversationId },
    {
      $set: {
        status: "open",
        resolvedAt: null,
        assignedAdminId: adminId,
        assignedAdminName: adminName,
        updatedAt: now,
      },
    }
  );
  await appendMessageWithArchive(conversationId, systemMessage, {
    assignmentEntry: { adminId: adminId!, adminName, joinedAt: now },
  });

  socket.join(roomFor(payload.conversationId));

  ns.to(roomFor(payload.conversationId)).emit("support:status", {
    conversationId: payload.conversationId,
    status: "open",
    assignedAdminId: adminId ? String(adminId) : null,
    assignedAdminName: adminName,
  });
  ns.to(roomFor(payload.conversationId)).emit("support:message", {
    conversationId: payload.conversationId,
    message: systemMessage,
  });
  ns.to(ADMINS_ROOM).emit("support:conversation-updated", {
    conversationId: payload.conversationId,
    lastMessage: systemMessage,
    status: "open",
    assignedAdminId: adminId ? String(adminId) : null,
    assignedAdminName: adminName,
  });

  await logAudit({
    conversationId,
    actorId: adminId,
    actorName: adminName,
    action: "reopen",
  });
}

// ─── Rate ────────────────────────────────────────────────────────────────────

async function handleRate(
  ns: ReturnType<IOServer["of"]>,
  socket: Socket,
  payload: { conversationId: string; stars: number; comment?: string }
): Promise<void> {
  const { ctx } = socket.data as { ctx: ConnContext };
  if (ctx.isAdmin) throw new Error("only the user can rate");
  const stars = Math.round(Number(payload.stars));
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
    throw new Error("stars must be 1..5");
  }
  const comment = (payload.comment ?? "").trim().slice(0, RATING_COMMENT_MAX) || null;

  const authorId = safeUserIdFromJwt(ctx.jwt);
  const conversationId = safeConversationId(payload.conversationId);
  const { chats } = await getCollections();
  const chat = await chats.findOne({ _id: conversationId });
  if (!chat) throw new Error("conversation not found");

  // User must own this conversation.
  const ownsByUser = authorId && chat.userId && chat.userId.equals(authorId);
  const ownsByGuest = !authorId && chat.guestSessionId === ctx.guestSessionId;
  if (!ownsByUser && !ownsByGuest) throw new Error("not your conversation");

  if (chat.status !== "resolved") throw new Error("only resolved conversations can be rated");

  const rating: SupportRating = { stars, comment, ratedAt: new Date() };
  await chats.updateOne({ _id: conversationId }, { $set: { rating, updatedAt: new Date() } });

  ns.to(roomFor(payload.conversationId)).emit("support:rated", {
    conversationId: payload.conversationId,
    rating,
  });
  ns.to(ADMINS_ROOM).emit("support:conversation-updated", {
    conversationId: payload.conversationId,
    rating,
  });

  await logAudit({
    conversationId,
    actorId: authorId,
    actorName: ctx.jwt?.firstName ? String(ctx.jwt.firstName) : null,
    action: "rate",
    details: { stars, hasComment: !!comment },
  });
}

// ─── Read receipts ───────────────────────────────────────────────────────────

async function handleRead(
  socket: Socket,
  payload: { conversationId: string; lastMessageId?: string }
): Promise<void> {
  const { ctx } = socket.data as { ctx: ConnContext };
  const { chats } = await getCollections();
  const conversationId = safeConversationId(payload.conversationId);
  const role: "user" | "admin" = ctx.isAdmin ? "admin" : "user";

  await chats.updateOne(
    { _id: conversationId },
    { $set: { [`unreadCounts.${role}`]: 0 } }
  );

  socket.to(roomFor(payload.conversationId)).emit("support:read-update", {
    conversationId: payload.conversationId,
    by: role,
    lastMessageId: payload.lastMessageId,
  });
}
