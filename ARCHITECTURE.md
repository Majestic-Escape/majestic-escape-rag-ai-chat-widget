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

1. **Browser widget** ([src/embed/useChat.ts](src/embed/useChat.ts)) POSTs straight to this service's `/api/chat` (cross-origin) with `{ message, mode, guestSessionId? }` and an optional `Authorization: Bearer <jwt>`. No conversation history is sent: the server keeps what it has understood so far.

2. **The route** ([src/app/api/chat/route.ts](src/app/api/chat/route.ts)) does request plumbing only, in this order:
   - AI kill-switch (first statement; fail-closed).
   - Identity and rate limits: 60/min and 200/day per signed-in user, 15/min and 30/day per IP, halved for an untrusted `Origin`.
   - Validates `message` (string, ≤2000 chars, control bytes stripped). `mode === "support"` returns the canned pointer to the Support tab.
   - Saves the user message to `ai_chat_messages` (fire-and-forget).
   - Reads `RAG_PIPELINE`: `safe` (default) answers with a fixed "use site search / Support" text and stops; `shadow` answers the same while running the pipeline silently; `v2` runs the pipeline. One 9-second deadline covers the whole turn, and it also stops when the browser goes away.
   - Runs the turn under a per-identity lock so one customer's turns are handled one at a time, in order.

3. **The pipeline** ([src/lib/rag/pipeline.ts](src/lib/rag/pipeline.ts)):

   | Stage | What happens | File |
   |---|---|---|
   | Fast path | Whole-message greetings, thanks, "start over", and yes/no to a pending question need no model. A filter chip removed in the widget arrives as `op` and is applied without a model. | `understand.ts`, `pipeline.ts` |
   | No-model reader | A short plain-English search ("villas in goa for 8 with pool") is read by patterns when every word is accounted for and the place resolves exactly; otherwise the model reads it. About 23 % of dev turns, all correct. | `quick.ts` |
   | Understand | One model call returns JSON describing what this message changes (place, dates, guests, budget, bedrooms, type, amenities, must-haves with no data field, soft wishes). The model sees only the previous requirements and the current message. | `understand.ts`, `llm.ts` |
   | Check | The JSON is validated strictly, corrected for known misreadings, then cross-checked against the text: every typed number must be used, none invented, a negation must remove something, a budget must be per night, dates must be real, in the future and mentioned. Any failure becomes a clarifying question and the state is left alone. | `understand.ts`, `guards.ts`, `numbers.ts`, `dates.ts` |
   | State | The change is merged into the customer's search state (`ai_chat_state`, one versioned document per signed-in user or guest id; 30-minute idle expiry). Newest instruction wins. | `state.ts` |
   | Retrieve | `GET {CATALOG_API_URL}/properties/search-properties` with the place and dates only, paged until every row is in. The response's `search.mode` says whether rows are in the place, merely nearby, or the place was not understood. | `catalog.ts` |
   | Judge | Every row × every requirement → satisfied / unsatisfied / unknown / unsupported. Confirmed = all satisfied. | `requirements.ts` |
   | Compose | Templates: the filters line, then the result. Unverifiable must-haves are asked about before anything is shown; nearby stays are labelled alternatives; no result explains exactly which requirement stood in the way. | `reply.ts` |
   | Validate | The finished reply is re-checked against the evidence (ids, prices, places, groups, availability). A defect means the reply is not sent. | `reply.ts` |
   | Commit | State (and the ids shown, for "the second one") is saved with a version check. | `state.ts` |

   Other intents get fixed text: policy questions (a link to the policy page, no figures), the customer's own booking (Support tab), general travel advice (not offered yet). Questions about, or comparisons of, stays already shown are answered from the listings' own fields ([inquire.ts](src/lib/rag/inquire.ts)).

4. **The reply** is sent as Server-Sent Events in the widget's existing format: the text (newlines escaped), then `data: [PROPS]<json>` with up to 8 cards, then `data: [DONE]`. Text goes first because the widget hides a reply until it has text. The reply and its cards are saved to `ai_chat_messages`; saved cards carry `availability: "recheck"`, never `"available"`.

   Bundles that send `caps: 1` also get `data: [META]{...}` lines: first `{"status":"Reading your message…"}` / `{"status":"Searching stays…"}` (shown in the typing bubble), then `{"filters":[…],"heading":"…"}` (removable chips with a Clear action, and the group heading above the cards). For them the text omits the filters line, which the chips replace. Older bundles never receive `[META]` and keep the filters line as the first line of text, so they render correctly unchanged.

5. **On the next page load**, the widget calls `/api/chat/history` to restore the conversation by `userId` (JWT) or `guestSessionId` (year-long cookie), cards included. The widget always sends its guest id. When a sign-in token is sent but does not verify (expired, or left behind after sign-out), both routes use a guest id derived from that token (`guestIdForUnverifiedToken` in `state.ts`): that visitor keeps their memory and history, and the next plain guest on the same browser cannot restore them.

6. **Property cards UI** — a horizontal snap-carousel of portrait cards (`src/embed/ChatWidget.tsx → PropertyCarousel`), at most 8, followed by a "Browse all stays" tile linking to `/stays`. A card can carry a badge: "Available for your dates" (from this reply's dated search), "Recheck availability" (restored from history), or a note such as "9 km from Panaji" or "Not verified: private pool". Prices read "/night · excl. taxes".

### What the assistant will not do

- State a total price, taxes or fees — `server.me` has no quote endpoint.
- Promise availability — it reports what a dated search returned in that reply; booking confirms.
- Treat a requirement it cannot check (private pool, pet-friendly, wheelchair access, distance to a beach) as met.
- Show anything a model wrote.

### What can go wrong here

| Symptom | Likely cause | Where to look |
|---|---|---|
| Every reply is "Stay search by chat is being upgraded…" | `RAG_PIPELINE` is unset or `safe` | Railway env |
| "I couldn't process that just now" | Both model attempts failed (retired model id, timeout, bad JSON) | log line `{"t":"rag", …, "llm":{…}}`; `LLM_CHAIN` |
| "I'm getting a lot of questions right now" | `DAILY_AI_LIMIT_GLOBAL` reached, or the `ai_usage` counter is unreadable | `ai_usage` collection |
| "Search is temporarily unavailable" | `server.me` search returned a non-200 or an unexpected shape | `CATALOG_API_URL`; `npm run verify:rag` against a fresh `node scripts/capture-search-contract.mjs` |
| A clarifying question after a clear message | A cross-check was too strict for that phrasing | add the message to `eval/golden/dev`, then `npm run eval:rag -- --live --only <id>` |
| 429 immediately | Rate-limit bucket still active | [rateLimit.ts](src/lib/rateLimit.ts) — buckets reset on process restart |

---

## 5. Real-time support chat

Files: [src/lib/supportSocket.ts](src/lib/supportSocket.ts), [src/app/api/support/conversations/[id]/transcript/route.ts](src/app/api/support/conversations/[id]/transcript/route.ts)

### Connection handshake

A client connects to the `/support` Socket.IO namespace with:

- `auth.token` — a JWT (users and admins), verified with the shared `JWT_SECRET` (same secret as `server.me`). A token without a valid ObjectId `userId`/`id` is treated as no token.
- `auth.guestSessionId` — the browser's guest id (`localStorage.meSupportGuestId` + a year-long cookie). **Untrusted input**: it is used only if it is a string matching `^[A-Za-z0-9_-]{1,100}$`; anything else (an object such as `{"$ne": null}`, an array, a long string) is dropped before it can reach a query.
- `auth.proto` — `2` for current widget bundles (drafts, below); absent/`1` for bundles built before them.

A socket with neither a usable token nor a usable guest id is refused. Every event payload is validated for shape before use (24-hex ids, text ≤ 2000, `clientMessageId` ≤ 64 of `[A-Za-z0-9_-]`, integer stars 1–5, comment ≤ 500, ack must be a function); anything else is an error ack or a no-op, never a database effect.

### What is "admin"?

A connection is treated as admin if any of the following match the JWT:

1. `payload.role === "admin"`
2. `payload.admin === 1` (the legacy claim from `server.me`'s loginController)
3. `payload.userId` is in `ADMIN_USER_IDS` env var (comma-separated allow-list — needed because `admin.site`'s OTP login currently doesn't stamp the `admin` claim)
4. `payload.email` is in `ADMIN_EMAILS` env var

Once any of these matches, [supportSocket.ts:onAdminConnect](src/lib/supportSocket.ts) runs instead of `onUserConnect`. The token is only the entry ticket: every admin action re-reads the `admins` record (for the current name and standing) and a banned, deactivated or demoted admin is refused and disconnected; idle admin sockets are re-checked every 5 minutes; every socket is disconnected when its JWT expires. The REST routes (transcript, delete) apply the same record check.

### Names are read from the records

The customer's and the agent's names shown anywhere in support — the inbox row, the widget's "X is helping you", "handled by X", the handover / resolve lines written from now on, the transcript header, audit rows — come from `users` / `admins` (`firstName`, `lastName`) at the time of the action or the read, via [`src/lib/supportNames.ts`](src/lib/supportNames.ts). `server.me` owns those names (an admin renames users from the Users grid; admins rename themselves in Settings). The JWT `firstName` claim is only what was true at sign-in and lives 7 days, and `support_chats.userFirstName` / `assignedAdminName` are only what was true when written — they remain as the fallback for a record that no longer exists. Lines already written (system chips, transcript lines) keep the names they were written with: they are history.

### Conversation lifecycle

```
customer opens the Support tab
    │
    ▼
onUserConnect (serialised per socket, under the customer's identity lock):
    guest history to claim? → one transaction moves it (see §7)
    an unresolved conversation?               → join it ("support:joined" with history)
    else resolved + unrated within 7 days?    → join it with the rating prompt
    else, proto 2 (current bundles)           → "support:joined" with conversationId: null — a DRAFT.
                                                Nothing is written; no agent sees anything.
    else, proto 1 (old bundles)               → create it now (createdBy: "legacy-open"),
                                                but don't announce it — it stays out of the inbox
    │
    ▼
first customer message (support:message with conversationId: null from a draft):
    find-or-create under the identity lock; creation is guarded in the DATABASE by
    activeKey ("u:<userId>") + a unique partial index, so two tabs / two instances
    can't both create one (the loser attaches to the winner)
    → every socket of the customer joins the room and gets "support:started"  (before the echo)
    → the message is appended (one conditional pipeline update)
    → the inbox gets "support:new-conversation" — exactly once, when the post-image holds
      exactly one customer message
    │
    ▼
agent opens it → support:assign → handleAssign (CAS on the previous assignee):
    same agent → silent re-join; another agent → "handover" line; none → "join" line, status open
    │
    ▼
both ends in the Socket.IO room "support:<convId>"; customer-facing events also go to the
customer's identity room "identity:u:<id>", so a second tab still in its draft hears them
    │
    ▼
agent resolves → status resolved + system line in ONE update (only the winner writes it),
activeKey removed, the customer gets the rating prompt
    │
    ▼
customer rates (only while resolved, only the owner) or skips (owner only)
```

Old bundles and conversations created before this change keep working: a conversation with no customer message is simply not listed until one arrives; documents without `rev` / `activeKey` / `seq` behave as before (reads "read all", unread counts start from the stored value).

**Failure boundaries.** The database is authoritative; socket events are best-effort (Socket.IO delivers at most once). A crash after a commit but before its events is repaired by the next inbox load (the conversation is there) and by the customer's reconnect (it joins the same conversation — no new document). Cross-instance *event* delivery during a deploy overlap is not provided (no socket.io adapter); cross-instance *creation* is safe via `activeKey`.

### Ordering, idempotency and limits

- **Per socket, in order.** A socket's lifecycle events (join, start, message, admin actions, rating) run one at a time in a bounded queue (≤ 32 waiting; a task that waited > 15 s is dropped unstarted with an error ack). Starts are never dropped — at most one runs and one waits, and every start is answered. The connection-time join answers the client's first `support:start`.
- **Locks.** The identity lock and the guest lock are held until the holder's database work settles (never released on a timer); work under a lock uses `maxTimeMS` 5000; a waiter gives up after 10 s with "busy — try again".
- **Conditional writes.** Every write carries ownership and expected state in its filter (customer append: owner and not resolved; assign: CAS on the previous assignee; resolve: not resolved; reopen: resolved; rate: owner and resolved; rating-dismissed: owner). Zero matches → an explicit error, nothing written.
- **Commit order.** Each mutation increments `rev` in the same atomic update; messages carry `seq` (= that `rev`) and customer messages a running `userIdx`. Admin events and rows carry `rev` plus absolute state, so the inbox keeps the highest `rev` and never counts on its own. Unread = `userMsgs − readUserIdx.admin`, exact past the 500-message ring. Admin read receipts send `{seq, messageId}`; the server accepts them only if that message is in this conversation and advances with `$max` (a late, older receipt can't restore unread).
- **Dedupe window.** `clientMessageId` is checked inside the append's filter. Every append to a conversation — customer, agent, system, auto — is capped at 120 per minute per conversation, so the 500-message ring always holds at least the last 2 minutes: a resend with the same id within 2 minutes is answered with the original (`duplicate: true`, no broadcast, no unread, no auto-ack); the same id with different text is refused.
- **Light events.** `support:typing` only into a room the socket is in (no DB read), 10 per 10 s; `support:read` 30/min; `support:fetch-history` 10/min; `support:admin-more` 30/min.
- **History.** `support:fetch-history` authorises in the read's own filter, joins the room, then reads — never joins first.

### Where every message is stored

Two collections, on purpose:

- **`support_chats.messages[]`** — a ring buffer holding the **latest 500** messages. Read by the live UI (admin reply panel, user widget rejoin) for fast access. When the array reaches 500 and a new message arrives, the oldest entry is dropped (`$slice: -500` inside the append's pipeline).
- **`support_chats_archive`** — every message ever sent is logged here as a standalone document `{conversationId, message, archivedAt}`. A unique compound index on `(conversationId, message._id)` makes retries idempotent.

The transcript export endpoint reads from the archive, so users always get the full history.

### Why this two-collection design?

1. The 500-message ring buffer keeps each `support_chats` doc small (~250KB max) so admin list reads are fast.
2. Compliance / legal requires that no message is ever silently dropped. The archive is the log.
3. **Ring-first, archive-second with retry**: the append writes the live ring FIRST so the message is visible immediately, then writes the archive with up to **3 retries** (50ms / 200ms backoff); the unique index makes retries idempotent. If all 3 fail the message is still in the ring and `[support] archive insert FAILED after 3 retries` is logged for an operator. **Known limitation:** if the ring later evicts that message, the transcript loses it; a repair job could only copy messages still in the ring.

### Auto-acknowledgement (no LLM)

When a customer message lands in a conversation with no agent assigned and no auto-acknowledgement in the last 5 minutes, the server appends a templated **system message with `kind: "auto"`** (first-ack vs follow-up template, chosen from the append's post-image). This is **not** an LLM call. The guard is atomic — the append's filter includes `assignedAdminId: null` and `$nor: [{ messages: { $elemMatch: { from: "system", kind: "auto", createdAt: { $gte: fiveMinAgo } } } }]` — so concurrent first messages produce exactly one. It is not announced to the inbox as its own event.

The client renders these as **regular agent bubbles** — `toLocal()` maps `{from:"system", kind:"auto"}` → `role:"model"`. Only `join` / `handover` / `resolve` / `reopen` render as centred italic chips.

### The widget's side (`useSupportChat`)

- Sends `proto: 2`; a join can be a draft (`conversationId: null`). Events that arrive before this connection's join are held (≤ 100) and applied after it.
- `support:started` is taken when the tab has nothing else open (a draft, the same conversation, or a resolved one it was showing).
- Joins and starts merge the server history into the thread (`mergeInto` in [`src/embed/supportThread.ts`](src/embed/supportThread.ts)): bubbles on screen keep their React key, so an echo never re-fades its bubble.
- Outbox (≤ 20): a send with no answer in 10 s (or a dropped connection) becomes "Delivery not confirmed"; after a reconnect it is resent automatically **once**, with the same id, only within 2 minutes of the first send, only into the conversation it targeted (a draft message only into a draft), and only if the rejoin's history lacks it. A refusal returns the text to the message box when it is empty, otherwise the bubble shows "Not sent · Retry · Remove". A manual retry the server can no longer deduplicate asks "This may already have been delivered" first and goes as a new message.
- "Start fresh" is hidden in Support until the customer has written something, and warns when messages are still unconfirmed.

### Socket events at a glance

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `support:start` | client → server | `{}` | (re)load the customer's state; answered with `support:joined` |
| `support:joined` | server → client | `{conversationId \| null, history, status \| null, assignedAdminId, assignedAdminName, rating, awaitingRating}` | state on connect / start; `conversationId: null` = draft (proto 2) |
| `support:started` | server → customer's sockets | `{conversationId, status, assignedAdminId, assignedAdminName, history}` | the customer's conversation now exists (sent before the first message's echo) |
| `support:message` | client → server / server → room | in: `{conversationId \| null, text, clientMessageId?}`; ack `{ok, conversationId, messageId, duplicate?}` or `{ok:false, error}` | new message (`null` from a draft creates the conversation) |
| `support:typing` | client → server / server → room | `{conversationId, isTyping}` | typing indicator; only into a room the socket is in, rate-limited |
| `support:read` | client → server | customer: `{conversationId}`; admin: `{conversationId, seq, messageId}` (legacy `lastMessageId`) | mark read (ownership / message validated in the write) |
| `support:assign` / `support:resolve` / `support:reopen` | admin → server | `{conversationId}` (ack `{ok}`) | take / close / re-open (reopen is refused while the customer has another open conversation) |
| `support:rate` | customer → server | `{conversationId, stars, comment?}` (ack) | rating, only while resolved |
| `support:rating-dismissed` | customer → server | `{conversationId}` (ack `{ok}`) | skip the rating prompt (owner only) |
| `support:status` | server → room + identity | `{conversationId, status, assignedAdminId?, assignedAdminName?}` | lifecycle change |
| `support:rated` | server → room | `{conversationId, rating}` | rating recorded |
| `support:admin-init` | server → admin | `{conversations: Row[], hasMore, openCount}` | first inbox page (50, conversations with a human message, newest first) |
| `support:admin-more` | admin → server | `{before: {updatedAt: ISO, id}}`; ack `{ok, conversations, hasMore, openCount}` | next inbox page by cursor |
| `support:new-conversation` | server → admins | `{conversationId, userFirstName, conversation: Row}` | a conversation's first customer message landed |
| `support:conversation-updated` | server → admins | `{conversationId, rev, …absolute fields that changed: lastMessage, status, unread, updatedAt, assignedAdminId/Name, resolvedAt, rating}` | row update — keep the highest `rev`; `lastMessage` of a system line is not a preview |
| `support:fetch-history` | client → server | `{conversationId}` | full history (admin or owner) |
| `support:history` | server → client | `{conversationId, messages}` | archive-only older messages + the live ring, in commit order |
| `support:error` | server → client | `{reason}` | non-fatal errors |

`Row` = `{conversationId, userId, guestSessionId, userFirstName, userLastName, userName, status, lastMessage (latest customer/agent message, ≤ 160 chars), unread, updatedAt, assignedAdminId, assignedAdminName, rating, resolvedAt, rev}` — names live from the records.

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
2. On connect, [`onUserConnect`](src/lib/supportSocket.ts) sees BOTH a JWT and a valid `guestSessionId` → once per socket, under the guest-id lock, ONE multi-document transaction moves the guest's `support_chats` AND `ai_chat_messages` into the account (a failure between the two moves neither). Claimed conversations lose their `activeKey`.
3. Sockets still signed out with that guest id are removed from the claimed conversations' rooms before the claim is announced, and history reads carry the owner condition in their own filter — a guest tab left open can't keep reading the account's thread.

After that, the guest's history follows the user across devices.

---

## 8. Security guardrails (and what they block)

| Surface | Defence | What attacker can't do |
|---|---|---|
| `/api/chat` | JWT-aware rate limit (60/min user, 15/min IP), daily cap (200/30), Origin allow-list halves rate when missing | Drain Gemini quota / rack up bills |
| `/api/chat` body | `validateUserMessage` (string only, ≤2000 chars), `sanitizeText` (strips control bytes) | Inject NULs / corrupt logs |
| `/support` socket auth | A JWT with a valid ObjectId user id, or a well-formed `guestSessionId` (strings matching `^[A-Za-z0-9_-]{1,100}$` only) | Connect without an identity; pass `{"$ne": null}` as a guest id to read a stranger's thread or claim every guest's history |
| `/support` token lifetime | Sockets disconnect at JWT expiry; admin standing re-read per action and every 5 min (and on the REST routes) | Keep acting as an admin after a ban / demotion |
| `/support` admin events | Each `support:assign/resolve/reopen` checks `ctx.isAdmin` server-side | Promote themselves / close other people's chats |
| `/support` cross-tenant | Ownership and expected state inside every write's filter (message, read, rate, rating-dismissed) and every history read's filter | Send into, read, rate or dismiss someone else's conversation — including by racing a check |
| Conversation IDs | `safeConversationId()` regex (`^[0-9a-f]{24}$`) before any `new ObjectId(...)` | Inject `{$ne: null}` Mongo operators |
| `clientMessageId` field | `^[A-Za-z0-9_-]{1,64}$` | Same as above, via the dedup field |
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

This deletes from `support_chats`, all archive rows, and writes a `delete` row to `support_audit` (named from the admin's record). A banned or demoted admin is refused even with an unexpired token.

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
| `support_chats` | this service | `{userId, guestSessionId, userFirstName (fallback copy), status, messages[] (each with `seq`, customer ones `userIdx`), assignmentHistory[], rating, rev, userMsgs, readUserIdx.admin, activeKey (only while unresolved), createdBy ("first-message" \| "legacy-open"), ...}` — indexes `active_key_unique` (unique partial), `user_status_updated`, `guest_status_updated` (partial), `status_updated`, `updated_id`, created at startup |
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
