# Majestic Escape Chatbot — Architecture & Developer Guide

This document is a hand-off for any developer who is touching the chatbot for the first time. Read this top-to-bottom and you will be able to find any feature, change anything safely, and ship to production.

If a sentence here disagrees with what the code actually does, the code wins — please update this doc as you discover the truth.

---

## 1. What problem does this service solve?

Majestic Escape needs two chatbot capabilities on its website:

1. **AI Assistant (RAG)** — answers travel questions ("villas in Goa with a pool") by searching its own property database and replying in natural language.
2. **Real-time Support chat (user ↔ admin)** — a guest chats live with a Majestic Escape support agent, similar to Intercom.

This repo is a **single Next.js service** that does both. It is meant to be deployed to **Railway** (always-on container, paid plan).

There are three other Majestic Escape repos that interact with this one. They are owned by other developers and you should not touch them:

| Repo | Role |
|---|---|
| `server.me` | Main backend (auth, properties, bookings). Off-limits. |
| `user.website` | The customer-facing site at majesticescape.in. As of Phase A, **only loads the embed bundle via one `<Script>` tag** in `layout.tsx` — no React widget code lives there. |
| `admin.site` | The internal admin panel. We add one new page (`/dashboard/support-chat`). |
| `majestic-chat` | Guest↔Host chat. **Unrelated** — do not couple our code to it. |

**Mental model:** this service owns "AI chat", "user↔admin support chat", **and** the customer-facing chat widget UI. Consumer sites embed it via a single `<script src="…/embed/widget.js">`.

### Phase A — zero-footprint embed (current architecture)

Until Phase A, the React chat widget lived inside `user.website/src/components/ai-chat/`. Every chat-only fix required a `user.website` PR + redeploy, which created churn for an unrelated developer.

Phase A moved the widget into this repo at [`src/embed/`](src/embed/) and ships it as a single Vite-built bundle at `/embed/widget.js` (~92 kB gzipped):

- **Custom element** — [`src/embed/main.tsx`](src/embed/main.tsx) registers `<majestic-chat-widget>`. The bundle auto-creates one on `<body>` if the host page doesn't include one explicitly, so integration is "drop in one script tag".
- **Shadow DOM** — Tailwind classes are compiled with the rest of the bundle and injected as a `<style>` tag inside the element's open Shadow Root, scoping ~25 kB of CSS so it can never leak into or out of the host page.
- **Backend URL resolution** — `src/embed/utils.ts → getBackendUrl()` picks (in order): `window.MAJESTIC_CHAT_BACKEND` page override → `VITE_BACKEND_URL` build-time env → origin of the loading `<script src>` → `window.location.origin`. So the widget always knows where its API lives, with no per-host config.
- **Cross-origin REST** — [`src/middleware.ts`](src/middleware.ts) handles OPTIONS preflights on `/api/chat/*` and tags responses with `Access-Control-Allow-Origin` based on `ALLOWED_ORIGINS` env (echoes the request origin in dev when unset).
- **Cross-origin Socket.IO** — [`server.ts`](server.ts) reads the same `ALLOWED_ORIGINS` env into the IO server's CORS config.
- **Static asset headers** — [`next.config.ts`](next.config.ts) sets `Access-Control-Allow-Origin: *` + `Cache-Control: max-age=300, swr=86400` on `/embed/*` so the bundle is cacheable across deploys without going stale for long.

---

## 2. The 30-second tour

```
┌──────────────────────────────────────────────────────────────────┐
│ user.website  (Next.js, port 3000)                               │
│  - Chat widget UI in user.website/src/components/ai-chat/         │
│  - /api/chat       → proxies to this service                     │
│  - /api/chat/history → proxies to this service                   │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTP POST/GET (server-side proxy)
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│ THIS SERVICE  (Next.js + Socket.IO, port 3003 / Railway)         │
│                                                                  │
│  HTTP routes:                                                    │
│    POST /api/chat                       — AI chat (SSE stream)   │
│    GET  /api/chat/history               — restore prior chats    │
│    GET  /api/health                     — Railway healthcheck    │
│    GET  /api/support/conversations/:id/transcript                │
│    DELETE /api/admin/conversations/:id  — admin only             │
│    POST /api/admin/embed-all            — admin only, bulk embed │
│                                                                  │
│  Socket.IO:                                                      │
│    /support namespace — real-time support chat                   │
│                                                                  │
│  Background workers (boot):                                      │
│    runCatchUpSync()        — re-embed missed properties          │
│    startChangeStreamWorker()— watch listingproperties for edits  │
└────────────────────────────┬─────────────────────────────────────┘
                             │ Reads + writes (raw mongodb driver)
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│ MongoDB Atlas                                                    │
│   listingproperties        (owned by server.me; we only write    │
│                              embedding + embeddingUpdatedAt)     │
│   bookings                  (read-only, for availability filter) │
│   support_chats             (own — live messages ring buffer)    │
│   support_chats_archive     (own — every message ever sent)      │
│   support_audit             (own — admin lifecycle actions)      │
│   ai_chat_messages          (own — AI chat persistence)          │
│   changestream_resume       (own — Change Stream resume token)   │
└──────────────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────────────┐
│ admin.site (Next.js, port 3001)                                  │
│   /dashboard/support-chat — agent reply console; connects to     │
│   THIS SERVICE's /support namespace                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Folder map

```
majestic-escape-rag-ai-chat-widget/
├── server.ts                     ← custom server: Next.js + Socket.IO + workers
├── railway.json                  ← Railway build/deploy config
├── package.json                  ← deps + scripts
├── .env.local                    ← local secrets (NOT committed)
└── src/
    ├── app/                      ← Next.js App Router routes
    │   ├── api/
    │   │   ├── chat/
    │   │   │   ├── route.ts      ← AI chat (RAG + streaming)
    │   │   │   └── history/route.ts ← list user's prior AI msgs
    │   │   ├── support/
    │   │   │   └── conversations/[id]/transcript/route.ts
    │   │   │                     ← export full chat (text or json)
    │   │   ├── admin/
    │   │   │   ├── embed-all/route.ts        ← re-embed every property
    │   │   │   ├── embed/[id]/route.ts       ← re-embed one property
    │   │   │   └── conversations/[id]/route.ts ← delete a convo
    │   │   └── health/route.ts   ← liveness + last-sync timestamps
    │   ├── globals.css           ← tailwind base + brand tokens
    │   ├── layout.tsx            ← root layout (loads Poppins + globals)
    │   └── page.tsx              ← landing page ("backend-only" notice)
    │
    ├── lib/
    │   ├── mongodb.ts            ← shared MongoClient singleton
    │   ├── jwt.ts                ← verifyToken + isAdminPayload
    │   ├── moderation.ts         ← input validation + sanitization
    │   ├── rateLimit.ts          ← in-memory sliding-window limiter
    │   ├── dateRange.ts          ← parses "next weekend" etc.
    │   ├── embedder.ts           ← buildPropertyText + embedAndSave
    │   └── supportSocket.ts      ← whole /support Socket.IO namespace
    │
    └── workers/
        ├── catchUpSync.ts        ← runs at boot; reconciles missed embeds
        └── changeStream.ts       ← long-lived watcher for property edits
```

> **This service is backend-only.** The user-facing chat widget lives in `user.website/src/components/ai-chat/`; the admin reply console lives in `admin.site/src/app/dashboard/support-chat/`. There is no chat UI in this repo — `page.tsx` is just a "backend-only" landing page so that hitting the root URL doesn't 404.

A good rule of thumb: when you need to find something, start from the route or the worker that handles the request, then follow imports into `lib/`.

---

## 4. The AI chat path, step by step

When a user types a message in the widget:

1. **Browser** → POSTs to `user.website` `/api/chat` with `{ message, history, mode, guestSessionId? }` and an optional `Authorization: Bearer <jwt>` header.

2. **user.website proxy** ([user.website/src/app/api/chat/route.ts](../user.website/src/app/api/chat/route.ts)) — forwards the request to this service, attaching `X-Forwarded-For` and `Origin` so rate-limiting and origin checks work correctly.

3. **This service** [src/app/api/chat/route.ts](src/app/api/chat/route.ts) does, in order:
   - Reads JWT from `Authorization`. If valid, the rate-limit key becomes `chat:m:user:<userId>`. Otherwise it falls back to `chat:m:ip:<ip>`. Logged-in users get 60 req/min; anonymous IPs get 15 req/min.
   - Checks daily cap (200 user / 30 IP per 24h). Returns 429 with friendly text on violation.
   - If the request's `Origin` header is missing or not in `ALLOWED_ORIGINS`, the per-minute and daily caps are halved (defends against scripted abuse).
   - Parses body, validates `message` (must be string, ≤2000 chars, non-empty after trim), strips control bytes via `sanitizeText`.
   - If `mode === "support"`, returns a canned redirect response (the user should switch to the Support tab; AI doesn't try to handle support tickets).
   - Otherwise: persists the **user message** to `ai_chat_messages` (fire-and-forget) so it survives cache wipes.
   - **Intent gate** ([`route.ts → shouldUseRag()`](src/app/api/chat/route.ts)): conversational fillers (`hi`, `thanks`), policy questions (`cancellation policy`, `refund`), booking-management (`my booking`, `cancel my booking`), and meta (`who are you`) skip vector search entirely and the LLM answers conversationally with no carousel. Discovery messages (everything else) fall through to the RAG pipeline below.
   - Embeds the query with Gemini's `gemini-embedding-001` model.
   - Runs Atlas Vector Search against `listingproperties.embedding` with `status: "active"` filter. Top 10 candidates.
   - Tries to extract a date range from the message + last user history turn. If found, queries `bookings` to mark conflicting properties `partiallyBooked: true`.
   - Sorts: available first, then by vector score. Slices to top 5.
   - Builds a context block summarising those 5 properties.
   - Calls Gemini 2.0 Flash with `BASE_SYSTEM_PROMPT + contextBlock + SAFETY_DIRECTIVE`. Streams tokens back as Server-Sent Events.
   - On Gemini quota error → falls back to Groq (`llama-3.3-70b-versatile`), then xAI (`grok-3-mini`). Whichever provider answers, the same SSE format is emitted.
   - When the stream finishes, persists the **model's full reply** to `ai_chat_messages`.
   - Final `data: [PROPS]<json>\n\n` line carries the property cards the widget renders below the text.

4. **Browser widget** ([user.website/src/components/ai-chat/useChat.ts](../user.website/src/components/ai-chat/useChat.ts)) — appends each chunk to the visible message bubble.

5. **On the next page load**, the widget calls `/api/chat/history` to restore the conversation. Lookup is by `userId` (from JWT) or `guestSessionId` (from the year-long cookie). This is what makes "history doesn't disappear after clearing cache" work. The persisted `ai_chat_messages.properties` field is rehydrated alongside the model reply, so the property-card carousel below each AI message survives reloads identically to the text.

6. **Property cards UI** — the model reply renders a horizontal snap-carousel of portrait property cards (in `src/embed/ChatWidget.tsx → PropertyCarousel`). Centred card sits at full scale; neighbours fade to `scale-95 opacity-80`. Touch-swipe on mobile, drag + chevron buttons on desktop ≥768px, dot indicator below. Final tile is a "See all matching stays" link to `/stays`. **The carousel intentionally caps at 8 cards** — users who want every match tap the trailing "See all matching stays" tile which routes to `/stays?q=…` on the consumer site for the full result set. Server-side filter: only candidates with vector score `> 0.65` are surfaced as cards (the LLM's grounding context still uses the full top-8 so it has options when summarising). Below 0.65 the match is not confident enough to be promoted as a recommendation.

### What can go wrong here

| Symptom | Likely cause | Where to look |
|---|---|---|
| 401 on `/api/chat` | Missing/expired JWT — but the route doesn't actually require auth, so this only happens if you sent garbage | [route.ts](src/app/api/chat/route.ts) JWT decode block |
| 429 immediately | Rate-limit bucket from prior abuse still active | [rateLimit.ts](src/lib/rateLimit.ts) — buckets reset on process restart |
| Empty replies / "let me look that up" | Atlas Vector Search index missing or mis-named | Atlas console → indexes on `listingproperties` |
| `Stream error: AI not available` | All three providers returned errors (Gemini quota + Groq + xAI all down) | check provider dashboards; verify keys in env |
| `No specific properties found` | The `embedding` field is missing from `listingproperties` | run `POST /api/admin/embed-all` once |

---

## 5. Real-time support chat

Files: [src/lib/supportSocket.ts](src/lib/supportSocket.ts), [src/app/api/support/conversations/[id]/transcript/route.ts](src/app/api/support/conversations/[id]/transcript/route.ts)

### Connection handshake

A client connects to `/support` Socket.IO namespace with EITHER:

- `auth: { token: <JWT> }` — for logged-in users and admins. JWT is verified with the shared `JWT_SECRET` (same secret as `server.me`).
- `auth: { guestSessionId: "g_<uuid>" }` — for anonymous guests. The id is browser-generated and lives in BOTH `localStorage.meSupportGuestId` AND a year-long `meSupportGuestId` cookie.
- Both are also accepted at once. This is how "sign-in upgrade" works (see Fix 7 below).

The middleware in `mountSupportNamespace` rejects connections that present neither.

### What is "admin"?

A connection is treated as admin if any of the following match the JWT:

1. `payload.role === "admin"`
2. `payload.admin === 1` (the legacy claim from `server.me`'s loginController)
3. `payload.userId` is in `ADMIN_USER_IDS` env var (comma-separated allow-list — needed because `admin.site`'s OTP login currently doesn't stamp the `admin` claim)
4. `payload.email` is in `ADMIN_EMAILS` env var

Once any of these matches, [supportSocket.ts:onAdminConnect](src/lib/supportSocket.ts) runs instead of `onUserConnect`.

### Conversation lifecycle

```
guest opens support tab
    │
    ▼
onUserConnect:
    if logged-in user has prior convos → load most recent open one
    elif unrated resolved within 7 days → show rating prompt
    else → create new pending convo, broadcast "support:new-conversation" to all admins
    │
    ▼
admin clicks the conversation in /dashboard/support-chat
    │
    ▼
support:assign emit
    │
    ▼
handleAssign:
    if admin already assigned → join room, return (no-op)
    else if a different admin was assigned → push "handover" system msg
    else → push "join" system msg, set status: open
    │
    ▼
both ends in same Socket.IO room "support:<convId>"; messages broadcast there
    │
    ▼
admin clicks "Mark resolved" → handleResolve → status: resolved, system msg, user gets rating prompt
    │
    ▼
user submits stars → handleRate → rating saved, broadcast to admin
```

### Where every message is stored

Two collections, on purpose:

- **`support_chats.messages[]`** — a ring buffer holding the **latest 500** messages. Read by the live UI (admin reply panel, user widget rejoin) for fast access. When the array reaches 500 and a new message arrives, the oldest entry is automatically dropped via MongoDB's `$slice: -500` operator.
- **`support_chats_archive`** — every message ever sent is permanently logged here as a standalone document `{conversationId, message, archivedAt}`. A unique compound index on `(conversationId, message._id)` makes retries idempotent.

The transcript export endpoint reads from the archive, so users always get the full history.

### Why this two-collection design?

1. The 500-message ring buffer keeps each `support_chats` doc small (~250KB max) so admin list reads are fast.
2. Compliance / legal requires that no message is ever silently dropped. The archive is the immutable log.
3. **Ring-first, archive-second with retry**: `appendMessageWithArchive` pushes to the live ring buffer FIRST so the message is visible immediately, then writes to the archive with up to **3 retries** (50ms / 200ms backoff). The unique compound index on `(conversationId, message._id)` makes retries idempotent. If all 3 archive retries fail, the message is still in the ring buffer and we log `[support] archive insert FAILED after 3 retries` for an operator to chase. This trades the prior "archive-first" strict ordering for live-visibility-first, which matters more in a real-time chat.

### Auto-acknowledgement (no LLM)

Files: [src/lib/supportSocket.ts → handleIncomingMessage](src/lib/supportSocket.ts) (the auto-ack block immediately after the user-message broadcast).

When a user sends a message into a conversation that has no admin assigned yet, the server emits a templated **system message with `kind: "auto"`** so the user gets an instant acknowledgement instead of staring at a silent void. This is **not** an LLM call — it's a static template chosen from two strings (first-ack vs follow-up).

Race-safe via atomic `updateOne`:

```ts
chats.updateOne(
  {
    _id: conversationId,
    assignedAdminId: null,
    $nor: [{ messages: { $elemMatch: { from: "system", kind: "auto", createdAt: { $gte: fiveMinAgo } } } }],
  },
  { $push: { messages: { $each: [autoMsg], $slice: -MAX_MESSAGES_PER_CONVO } } }
)
```

If two user messages arrive concurrently, exactly one update succeeds; the others see `matchedCount === 0` and skip the emit. No double-firing. Once an admin engages, `assignedAdminId !== null` short-circuits the whole block — no auto-ack noise on top of an active human conversation.

The client renders these messages as **regular agent bubbles** (left-aligned, white card, headset avatar) — `useSupportChat → toLocal()` maps `{from:"system", kind:"auto"}` → `role:"model"` so it visually matches the greeting and any subsequent admin replies. Only the legitimately-event-y kinds (`join` / `handover` / `resolve` / `reopen`) render as centred italic chips.

### Socket events at a glance

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `support:joined` | server → client | `{conversationId, history, status, assignedAdminName, rating, awaitingRating}` | initial state on connect |
| `support:message` | client → server / server → room | `{conversationId, text, clientMessageId?}` | new message |
| `support:typing` | client → server / server → room | `{conversationId, isTyping}` | typing indicator (debounced 2s, server verifies sender owns the conversation before broadcasting) |
| `support:read` | client → server | `{conversationId, lastMessageId?}` | mark messages read |
| `support:assign` | admin → server | `{conversationId}` | take ownership |
| `support:resolve` | admin → server | `{conversationId}` | close convo |
| `support:reopen` | admin → server | `{conversationId}` | re-open a resolved convo |
| `support:rate` | user → server | `{conversationId, stars, comment?}` | submit rating |
| `support:rating-dismissed` | user → server | `{conversationId}` (server acks `{ok}`) | skip the rating prompt — client must wait for ack before emitting `support:start`, otherwise `onUserConnect` re-finds the still-unrated convo and replays the prompt |
| `support:status` | server → room | `{conversationId, status, assignedAdminId?, assignedAdminName?}` | lifecycle change |
| `support:new-conversation` | server → admins | `{conversationId, userFirstName}` | a new pending convo |
| `support:conversation-updated` | server → admins | `{conversationId, lastMessage, status, ...}` | one-shot list refresh |
| `support:rated` | server → room | `{conversationId, rating}` | rating recorded |
| `support:fetch-history` | client → server | `{conversationId}` | request full message history (admin or owner only) — used by admin reply console when opening a conversation |
| `support:history` | server → client | `{conversationId, messages}` | replay of the full archived history (live + archive, deduped, sorted by `createdAt`) |
| `support:error` | server → client | `{reason}` | non-fatal errors |

---

## 6. Embedding maintenance (the worker layer)

Files: [src/workers/changeStream.ts](src/workers/changeStream.ts), [src/workers/catchUpSync.ts](src/workers/catchUpSync.ts), [src/lib/embedder.ts](src/lib/embedder.ts)

The AI chat is only as good as the embeddings stored on each property document. We keep them in sync **automatically**.

### At boot

`server.ts` fires two background tasks (in parallel, non-blocking):

1. **`runCatchUpSync()`** — finds every active property where:
   - `embedding` is missing, OR
   - `updatedAt > embeddingUpdatedAt`

   Re-embeds those in batches of 50. This is a safety net for cold-starts and post-deploy reconciliation.

2. **`startChangeStreamWorker()`** — opens a MongoDB Change Stream on `listingproperties`. Every insert/update/replace/delete fires within ~100ms. The worker:
   - On `insert` / `replace` → `embedAndSaveProperty(id)` (always re-embed, since you can't tell what changed).
   - On `update` → only re-embeds if the changed fields are in `EMBED_TRIGGER_FIELDS` (title, description, amenities, etc.). Skips trivial things like `viewCount` updates.
   - On `delete` → `$unset` the embedding fields so the property disappears from vector search.
   - After processing a change, **persists the resume token** to `changestream_resume`. If the worker crashes/restarts, it picks up exactly where it left off.

### Resume-token expiry

If the service is offline for **more than ~24h** (the typical Atlas oplog window), the resume token expires. On next boot the Change Stream throws "ChangeStreamHistoryLost". The catch-up sync at boot is the safety net here.

### How to manually re-embed

If embeddings get corrupted or you change the prompt and want everything reindexed:

```bash
# Get an admin JWT first (login on admin.site, copy from localStorage)
curl -X POST https://chat-rag.majesticescape.in/api/admin/embed-all \
  -H "Authorization: Bearer <admin-jwt>"
```

Or for one property:

```bash
curl -X POST https://chat-rag.majesticescape.in/api/admin/embed/<propertyId> \
  -H "Authorization: Bearer <admin-jwt>"
```

---

## 7. Identity and how chats survive cache clears

Three identity types:

| Identity | How it's identified | What survives a cache wipe |
|---|---|---|
| **Logged-in user** | JWT (`userId` claim) | Everything — server lookup is by `userId`. As long as the user logs back in, they get the same conversations. |
| **Anonymous guest** | `guestSessionId` stored in BOTH `localStorage` and a 1-year `Set-Cookie`. Server uses whichever is sent. | Most cache-clear flows leave cookies — the cookie restores the localStorage entry on next load, and the server matches by the same `guestSessionId`. |
| **Admin** | JWT + `ADMIN_USER_IDS`/`ADMIN_EMAILS` env match | Server reads from DB on every connect — no client state involved. |

### Sign-in upgrade

If a guest sends a few messages and later signs in *in the same browser*:

1. The widget keeps sending the `guestSessionId` even after the user logs in.
2. On connect, [`onUserConnect`](src/lib/supportSocket.ts) sees BOTH a JWT and a `guestSessionId` → runs an `updateMany` that claims any `userId: null, guestSessionId: <id>` conversations into the user's account.
3. Same upgrade is applied to `ai_chat_messages`.

After that, the guest's history follows the user across devices.

---

## 8. Security guardrails (and what they block)

| Surface | Defence | What attacker can't do |
|---|---|---|
| `/api/chat` | JWT-aware rate limit (60/min user, 15/min IP), daily cap (200/30), Origin allow-list halves rate when missing | Drain Gemini quota / rack up bills |
| `/api/chat` body | `validateUserMessage` (string only, ≤2000 chars), `sanitizeText` (strips control bytes) | Inject NULs / corrupt logs |
| `/support` socket auth | Either valid JWT or `guestSessionId` required | Connect anonymously without an id |
| `/support` admin events | Each `support:assign/resolve/reopen` checks `ctx.isAdmin` server-side | Promote themselves / close other people's chats |
| `/support` cross-tenant | `handleIncomingMessage` re-checks ownership before every message | Send into someone else's conversation |
| Conversation IDs | `safeConversationId()` regex (`^[0-9a-f]{24}$`) before any `new ObjectId(...)` | Inject `{$ne: null}` Mongo operators |
| `clientMessageId` field | Type-checked: must be string, ≤64 chars | Same as above, via the dedup field |
| `support:rate` | Stars must be 1..5 integer, comment ≤500 chars, only allowed on `status === "resolved"` | Crash the rate handler / spam ratings |
| Prompt injection | Regex heuristic logs (does NOT reject); `SAFETY_DIRECTIVE` appended to every system prompt instructs the model to refuse | Force the LLM to leak the system prompt |
| Logs | `redactForLogs()` masks email, phone, card numbers before logging | PII in production logs |

### Audit trail

Every admin action — `assign`, `handover`, `resolve`, `reopen`, `rate`, `delete` — writes a row to `support_audit` with `{actorId, actorName, action, ts, details}`.

---

## 9. Environment variables

Stored locally in `.env.local`. In production, set on Railway → service → Variables.

```bash
# Required
GEMINI_API_KEY=AIza...                    # Gemini Developer API key
MONGODB_URI=mongodb+srv://...master-db    # Atlas connection string
JWT_SECRET=<same as server.me/.env>       # MUST match other services

# AI provider fallbacks (recommended for resilience)
GROQ_API_KEY=gsk_...
XAI_API_KEY=xai-...

# Admin allow-lists (until JWTs include role: "admin")
# Comma-separated emails or MongoDB userIds whose JWTs are treated as admin.
ADMIN_EMAILS=admin@example.com,ops@example.com
ADMIN_USER_IDS=<24-char-hex-id-of-admin-user>

# Cost guardrails
DAILY_AI_LIMIT_USER=200                   # AI calls / user / 24h
DAILY_AI_LIMIT_IP=30                      # AI calls / anonymous IP / 24h

# CORS + linking
ALLOWED_ORIGINS=https://majesticescape.in,https://admin.majesticescape.in,http://localhost:3000,http://localhost:3001
NEXT_PUBLIC_PROPERTY_BASE_URL=https://majesticescape.in
NEXT_PUBLIC_SUPPORT_SOCKET_URL=           # leave blank in prod (uses same origin)

# Server
PORT=3003                                 # Railway sets this; locally we pin 3003
```

---

## 10. Local development (canonical ports)

To run the whole stack locally:

| Service | Command | Port |
|---|---|---|
| `server.me` | `npm run dev` | 5005 |
| `user.website` | `npm run dev` (or `npm run build && npm start` if dev mode is broken) | 3000 |
| `admin.site` | `npm run dev` | 3001 |
| `majestic-chat` | `npm run dev:server` | 3002 |
| **this service** | `npm run dev` | **3003** |

The `useSupportChat` hook in `user.website` reads `NEXT_PUBLIC_SUPPORT_SOCKET_URL` — set to `http://localhost:3003` in dev (already the default).

After all five run, open `http://localhost:3000/stays`, click the floating chat icon. Both AI and Support tabs should work.

---

## 11. Common tasks (cookbook)

### "I want to change the AI's tone"

Edit `BASE_SYSTEM_PROMPT` in [src/app/api/chat/route.ts](src/app/api/chat/route.ts). No deploy needed for prompt-only changes.

### "I want to add a new field to the property context"

Edit `buildContext` in [src/app/api/chat/route.ts](src/app/api/chat/route.ts) AND `buildPropertyText` in [src/lib/embedder.ts](src/lib/embedder.ts). Then `POST /api/admin/embed-all` to reindex.

### "Add a new system message kind"

1. Extend the `SystemKind` union in [supportSocket.ts](src/lib/supportSocket.ts).
2. Add the message-creation in whichever handler triggers it.
3. Update the rendering in `admin.site/src/app/dashboard/support-chat/page.jsx` and `user.website/src/components/ai-chat/ChatWidget.tsx`.

### "I want to enforce a stricter daily AI limit"

Set `DAILY_AI_LIMIT_USER` / `DAILY_AI_LIMIT_IP` in Railway. Restart the service for it to take effect (env vars are read at boot only).

### "Re-index everything from scratch"

```bash
curl -X POST https://chat-rag.majesticescape.in/api/admin/embed-all -H "Authorization: Bearer <admin-jwt>"
```

### "Delete a single conversation (GDPR / mistake)"

```bash
curl -X DELETE https://chat-rag.majesticescape.in/api/admin/conversations/<convId> -H "Authorization: Bearer <admin-jwt>"
```

This deletes from `support_chats`, all archive rows, and writes a `delete` row to `support_audit`.

### "Export a conversation transcript"

As the conversation owner (or admin):

```bash
# Plain text
curl -H "Authorization: Bearer <jwt>" \
     https://chat-rag.majesticescape.in/api/support/conversations/<convId>/transcript

# JSON
curl -H "Authorization: Bearer <jwt>" \
     "https://chat-rag.majesticescape.in/api/support/conversations/<convId>/transcript?format=json"

# As a guest (no JWT)
curl "https://chat-rag.majesticescape.in/api/support/conversations/<convId>/transcript?guestSessionId=<id>"
```

### "Add a new admin event"

1. Add the listener in `mountSupportNamespace` and gate it on `ctx.isAdmin`.
2. Implement the handler. Always end with a `logAudit({ action })` call so abuse is traceable.
3. Add the corresponding emit on `admin.site/src/app/dashboard/support-chat/page.jsx`.

---

## 12. Database collections — short reference

| Collection | Owned by | Key fields |
|---|---|---|
| `listingproperties` | `server.me` | We only write `embedding`, `embeddingUpdatedAt` via raw driver |
| `bookings` | `server.me` | We read `{propertyId, status, checkIn, checkOut}` for availability filter |
| `support_chats` | this service | `{userId, guestSessionId, userFirstName, status, messages[], assignmentHistory[], rating, ...}` |
| `support_chats_archive` | this service | `{conversationId, message, archivedAt}` — unique on `(conversationId, message._id)` |
| `support_audit` | this service | `{conversationId, actorId, actorName, action, details, ts}` |
| `ai_chat_messages` | this service | `{userId, guestSessionId, role, text, createdAt, properties?}` — `properties` only set on `role:"model"` rows that returned property cards, so a reload restores the same carousel cards under each AI reply |
| `changestream_resume` | this service | Single doc — `{_id: "listingproperties", token, ts}` |

---

## 13. What to read next

- **Source code, in this order:** [server.ts](server.ts) → [supportSocket.ts](src/lib/supportSocket.ts) → [api/chat/route.ts](src/app/api/chat/route.ts) → [workers/changeStream.ts](src/workers/changeStream.ts) → [embedder.ts](src/lib/embedder.ts).
- **For deployment:** see [`RAILWAY_DEPLOYMENT.md`](RAILWAY_DEPLOYMENT.md).
- **For the original architecture decisions / tradeoffs:** the plan file in `~/.claude/plans/`. Reading it explains *why* certain things are the way they are (e.g. why a single Railway container; why two collections for messages; why we don't need Redis yet).

---

## 14. Contact / ownership

Owned by Shriraj. When in doubt, prefer additive changes over rewriting; this service is small enough to evolve safely with care.
