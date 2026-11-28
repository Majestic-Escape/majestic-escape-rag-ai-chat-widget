# Claude Code conventions for this repo

You're working on `majestic-escape-rag-ai-chat-widget` — a Next.js 15 service that backends the Majestic Escape AI chatbot **and** ships the customer-facing widget UI as a standalone embed bundle. Read [`ARCHITECTURE.md`](ARCHITECTURE.md) end-to-end before making non-trivial changes; the notes below are conventions and gotchas that aren't obvious from the code alone.

## Repository layout (where things actually live)

| Path | What it is | When to touch |
|---|---|---|
| `server.ts` | Boots Next.js + Socket.IO + workers (Change Stream, catch-up sync). Single entrypoint for `npm run dev` / `npm start`. | Adding new sockets, workers, or top-level lifecycle hooks. |
| `src/app/api/chat/route.ts` | Kill-switch → rate limits → validation → the search pipeline (`src/lib/rag`) behind `RAG_PIPELINE` (`safe` \| `shadow` \| `v2`). Writes the SSE reply. | Request plumbing only. Search behaviour lives in `src/lib/rag`. |
| `src/lib/rag/pipeline.ts` | One chat turn: fast path → understand → merge state → retrieve → judge → compose → validate → commit. Everything injected. | The order of the stages. |
| `src/lib/rag/understand.ts` | The extraction prompt, strict validation of the model's JSON, cross-checks against what the customer typed, the state merge. | What the assistant understands; new requirement fields. |
| `src/lib/rag/guards.ts`, `numbers.ts`, `dates.ts` | Deterministic corrections for misreadings seen in live evaluation; the numbers a customer typed; India-time calendar dates. | A new misreading pattern (add the case to `eval/golden/dev` first). |
| `src/lib/rag/requirements.ts` | Listing × requirement → satisfied / unsatisfied / unknown / unsupported. Pure. | Any rule about what counts as a match. |
| `src/lib/rag/catalog.ts` | Client for `server.me`'s public search: paging, mode classification, typed failure. | The backend contract. |
| `src/lib/rag/reply.ts` | Every customer-visible sentence of a search reply (templates) and the final validator. | Wording, cards, policy links. |
| `src/lib/rag/inquire.ts` | Questions about / comparisons of stays already shown. | New askable facts. |
| `src/lib/rag/state.ts`, `llm.ts`, `runtime.ts` | Versioned per-identity state (`ai_chat_state`); two-attempt model client; production wiring (env, Mongo, daily cap in `ai_usage`). | State storage, providers, env. |
| `eval/`, `scripts/verify-rag.ts`, `scripts/eval-rag.ts` | Golden conversations, saved API responses, the pure checks and the live evaluation. | Before and after any change to `src/lib/rag`. |
| `src/app/api/chat/history/route.ts` | Restores prior AI exchanges including the property-card array on reload. | History persistence. |
| `src/lib/supportSocket.ts` | The `/support` Socket.IO namespace: connection auth, conversation lifecycle, atomic auto-ack, typing authz, rating, archive write. | Anything user↔admin chat related. |
| `src/lib/embedder.ts` | Gemini embedding + raw MongoDB writes. Bypasses Mongoose. `EMBEDDER_VERSION` gates re-embedding. | Vector index logic, prose builder. |
| `src/lib/moderation.ts` | `validateUserMessage`, `sanitizeText`, char limits. | Inbound message gating. |
| `src/lib/rateLimit.ts` | In-memory sliding-window limiter. | Per-IP / per-user rate caps. |
| `src/lib/mongodb.ts` | Cached `MongoClient` singleton. | Touch only when changing connection options. |
| `src/middleware.ts` | CORS preflight + ACAO header on `/api/chat/*`. Echoes any origin in dev; strict allow-list in prod. | Cross-origin policy for the embed bundle. |
| `src/embed/main.tsx` | Custom-element entry (`<majestic-chat-widget>`). Mounts React inside an open Shadow Root, injects compiled CSS as `<style>`. | Element registration, Shadow DOM mount. |
| `src/embed/ChatWidget.tsx` | The full panel UI — launcher, header, tabs, message list, input, menu drawer, property carousel. | Any chat UI change. |
| `src/embed/useChat.ts` | AI chat hook (`/api/chat` SSE stream + history rehydrate). | AI side state. |
| `src/embed/useSupportChat.ts` | Support chat hook (Socket.IO `/support` namespace). | Support side state, including the rating-dismissed-then-start sequencing. |
| `src/embed/utils.ts` | `getBackendUrl()`, `getAuthToken()`, `getOrCreateGuestId()`, `useCurrentPathname()`. | Identity, backend URL resolution, route awareness. |
| `src/embed/styles.css` | Tailwind entry (`@tailwind base/components/utilities`) — bundled into `widget.js` and injected into Shadow DOM. | Adding base styles or `:host` vars. |
| `src/embed/types.ts` | `Message`, `PropertyCardData`, `ChatMode`, `SystemMessageKind`. | Shared types between hooks + UI. |
| `vite.embed.config.ts` | Library build for the embed bundle (IIFE, single-file output to `public/embed/widget.js`). `publicDir: false` to avoid copying public/* into output. | Bundle build flags. |
| `next.config.ts` | Adds CORS + cache headers on `/embed/*`. | Static asset headers. |
| `src/workers/changeStream.ts` | Long-lived MongoDB Change Stream watcher → `embedAndSaveProperty`. | Real-time embedding maintenance. |
| `src/workers/catchUpSync.ts` | Boot-time reconcile of properties whose `embeddingVersion < EMBEDDER_VERSION`. | After bumping `EMBEDDER_VERSION` or fixing missed events. |
| `scripts/createVectorIndex.js` | Idempotent Atlas Vector Search index creator. Run via `npm run atlas:create-index`. | One-time during cluster setup. |
| `public/embed/widget.js` | **Build artefact** — gitignored. Regenerated by `npm run build:embed`. | Never edit. |
| `public/embed-sandbox.html` | Smoke-test page for the bundle. Served at `/embed-sandbox.html`. | Updating the test fixture. |
| `docs/screenshots/` | README screenshots. | Updating the README visual showcase. |

## Commands you'll actually use

```bash
npm run dev            # tsx server.ts — Next + Socket.IO + workers, port 3003
npm run build          # build:embed (vite) → next build → build:server (esbuild). Railway runs this.
npm run build:embed    # vite build → public/embed/widget.js (~92 kB gzipped)
npm run build:server   # esbuild server.ts + src/** → dist/server.cjs
npm start              # NODE_ENV=production node dist/server.cjs (precompiled — NOT tsx)
npm run atlas:create-index  # idempotently create the listing_vector_index
npm run verify:support        # /support socket contract (real namespace, LOCAL Mongo replica set)
npm run verify:support-client # widget thread/outbox rules (pure, no server)
npm run verify:support-routes # transcript + delete routes (LOCAL Mongo)
npm run verify:rag            # search pipeline: pure checks (no network, no model) — run after ANY edit under src/lib/rag
npm run eval:rag              # golden conversations, replaying recorded answers
npm run eval:rag -- --live    # …against the real model and catalogue (costs a little; says something about the model)
npm run eval:rag -- --live --set heldout7  # release gate only: never read or tune against eval/golden/heldout*
bash scripts/regress.sh                    # free replay of every recorded answer (dev + reg-h3 / reg-h4), no model calls
npx tsx scripts/review-failures.ts --set reg-h4 eval/reports/reg-h4-<chain>-r1.json   # first wrong turn per failed conversation, by cause
npx tsx scripts/compare-runs.ts --set dev-fresh old=<report.json> new=<report.json>    # two runs on the same cases, by group (accuracy, unnecessary questions, carried-over mistakes)
```

There's no `npm test` or lint config beyond `next lint`. The `verify:*` scripts are standalone checks: the Mongo ones need a LOCAL replica set (default `mongodb://127.0.0.1:27417/?replicaSet=rs0`, override with `SUPPORT_VERIFY_MONGODB_URI`), refuse remote/SRV URIs, create a uniquely named database and drop only that one. `SUPPORT_VERIFY_ONLY=<group>` runs one group of `verify:support`. UI verification is done by driving `localhost:3000/stays` (user.website) and `localhost:3001/dashboard/support-chat` (admin.site) via Playwright MCP.

## Port assignments (the whole majestic-escape system)

| Port | Service | Repo | Notes |
|---|---|---|---|
| 3000 | user.website | `user.website` (Next.js) | Consumer site that embeds the chat |
| 3001 | admin.site | `admin.site` (Next.js) | Admin reply console for support chat |
| 3002 | majestic-chat | `majestic-chat` (separate repo) | Guest↔host messaging — **separate feature** from this chatbot. Code defaults to 3001 in `index.ts`; deployment guide says 3002. Set `PORT=3002` in env if running. |
| 3003 | **chat widget (this repo)** | `majestic-escape-rag-ai-chat-widget` | RAG chatbot + standalone embed bundle |
| 5005 | server.me backend | `server.me` (Express + Mongoose) | Properties, auth, bookings |

Never bind to 3000/3001/3002/5005 from this repo. The chatbot's port (3003) is overridable via `PORT` env (Railway injects its own in prod), but the consumer sites' dev defaults assume 3003.

**Production reminder**: ports are dev-only. Each service runs in its own container in prod with its own port assigned by the host platform. See [`RAILWAY_DEPLOYMENT.md` § 0](RAILWAY_DEPLOYMENT.md) for the production / staging env-var checklist that actually matters.

## Conventions

### Don't break user.website

The customer site (`user.website`) is owned by another developer. Phase A reduced the chatbot's footprint there to **one `<Script>` tag** in `layout.tsx`. Don't propose changes that re-introduce widget code into user.website. If you need a new client-side capability, build it inside `src/embed/` and ship via the bundle.

### The bundle is loaded cross-origin

The widget runs on `chat.majesticescape.in` and is loaded onto `majesticescape.in`. Two consequences:

1. **CORS matters**. `src/middleware.ts` handles preflights for `/api/chat/*`. Socket.IO CORS is set in `server.ts`. Both echo the request origin in dev (`NODE_ENV !== production`) and respect `ALLOWED_ORIGINS` in prod.
2. **`localStorage` is the host page's localStorage**, not the widget origin's. JWT reads work because the script runs in the host's window. Don't try to read cookies from the widget origin.

### Tailwind classes inside Shadow DOM

The bundle compiles Tailwind classes into a `<style>` tag injected into the Shadow Root. Three rules:

1. Any new utility (e.g. `bottom-28`) must appear **as a literal string** somewhere in `src/embed/**/*.tsx` or Tailwind's content-scanner won't find it.
2. **Don't reference user.website's globals.css from the widget**. The Shadow DOM is sealed; only what's in `styles.css` reaches the widget.
3. The `tailwind.config.ts` `content` glob includes `./src/embed/**/*.{js,ts,jsx,tsx}` — keep it that way.

### Adding a new socket event

When you add a new event to `supportSocket.ts`:

1. Document it in the `ARCHITECTURE.md §5` events table.
2. **Validate the payload's shape first** (`payloadOf`, `ackOf`, `safeConversationId`, the regexes at the top of the file). Socket payloads are untrusted: never let a raw value reach a query — `{"$ne": null}` where a string was expected is an operator injection.
3. **Authz inside the write.** Admin-only: `ctx.isAdmin` AND a fresh `actingAdmin` read (the record can have been banned since the handshake). User ops: put `ownerFilterOf(ctx)` and the expected state in the update's own filter — never check-then-write — and treat zero matches as an explicit error.
4. If it adds a message, go through `appendMessage` (one pipeline update: `rev`/`seq`, unread counters, dedupe, ring cap) then `archiveMessage`. Any other mutation of a conversation increments `rev` in the same update and puts `rev` + absolute state on its admin event.
5. If it changes lifecycle state, run it on the socket's queue (`state.queue.run`) so it can't interleave with the same socket's join or first message.
6. If the client needs to know "the server has committed this", give the event an ack and answer it on every path (`ackOf` makes a missing/foreign ack a no-op).

### When to use which message rendering

The client's `useSupportChat → toLocal()` decides:
- `from: "user"` → `role: "user"` → right-aligned green bubble
- `from: "system"` AND `kind` ∈ `{join, handover, resolve, reopen}` → `role: "system"` → centred italic chip (status events)
- Everything else (admin replies, system messages with `kind: "auto"`) → `role: "model"` → left-aligned agent bubble with headset avatar

If you add a new `SystemKind`, decide which bucket it belongs in and update `toLocal()`.

### The search pipeline (`src/lib/rag`) — the rules it rests on

The assistant does not "find similar stays" any more. It asks `server.me`'s public search for the place and the dates, then checks every returned stay against every requirement in code, and writes the reply from templates. Seven rules; each one was a defect in the old path or a measured trap in the backend:

1. **No model text reaches a customer.** The model returns one JSON object describing what the message changes; `validateProposal` and `crossCheck` decide whether to believe it. Replies are templates in `reply.ts`. Do not add a "let the model phrase it" step without a gate in `eval/`.
2. **A stay is a match only when every mandatory requirement is `satisfied`.** Missing data is `unknown`; a requirement no field can prove ("private pool", "pet-friendly") is `unsupported`. Neither is ever shown as a match — the customer is asked first (`possible_ask` → "yes" → `possible_shown`, labelled "not verified"). Never weaken a requirement to make results appear.
3. **Send the backend only the place and the dates.** Its other filters are dropped or inverted without an error (`placeType=entire` → both, `pets=true` → *no-pets* listings, a lone date ignored, unknown names ignored). `eval/contract/` holds real responses proving it; `npm run verify:rag` reads them.
4. **Rows are in-place only for `search.mode` `place` / `text`.** `nearby` means the backend widened the place by itself (stays up to 250 km away) — those are labelled alternatives. `all` after a place was sent means the place was not understood. An unknown mode is a failure.
5. **Page until every row is in (`limit=50`, max 4 pages).** The default page is 16. A capped or short result is `incomplete`, and any non-200 is `failed` — neither is ever worded as "no stays".
6. **State is per identity, versioned, and committed in arrival order.** The route holds `withKeyLock` per identity; `ai_chat_state` commits name the `rev` they read. A guest's state is never carried into an account. Only the previous state and the current message go to the model — no history, no listing text.
7. **Availability is said only from a dated search made in the same turn**, as "available when checked just now — confirmed at checkout". Saved cards are stored as `recheck`. Prices are the nightly base price, "before taxes and fees": `server.me` has no quote endpoint, and its own pricing comment says the site's display formulas differ.

8. **A follow-up is an explicit change to the current search.** A first message is read with `UNDERSTAND_SYSTEM` (compact: the values it sets); once a search exists, `UNDERSTAND_FOLLOWUP` returns a change list (`set` / `add` / `remove`, each with `said`, the customer's own words). Code applies only the listed changes, so everything else carries forward. A removal is applied only when its quoted words are in the message and name the requirement (`judgeRemovals`: field vocabulary or the current value); an unnamed removal beside another change is dropped, an unnamed removal on its own gets one focused question. A doubtful reading gets one focused question showing the resulting search (`confirmQuestion`, pending `confirm`); nothing is applied until "yes". Values stay in the customer's words (`ownWords`). Group sizes and stay dates are arithmetic in code (`headcount`, `completeDates`). (Example phrasings live in `scripts/verify-rag.ts`, groups `candidate-3` and `change-list`, not here: this file is loaded into every agent's context, including independent test authors.)

9. **Filters mode is the default (`RAG_SEARCH_MODE=filters`).** The guest sets the search with the widget's filter buttons and editor; each change is an op (`{set, unset, remove, unsupported, soft, reset}`) the pipeline applies with `validateProposal` + `applyDelta` and never a model call (an op that changes nothing ends without one). A typed message is at most a draft (`RAG_AI_DRAFT=on`): the reading is shown line by line (`draftOf`), nothing is committed, and the guest's Apply sends the chosen lines' ops. The draft's **Edit filters** opens the editor with the chosen lines already filled in (`draftEditPlan` in `FilterEditor.tsx`): lines the form can show become form values, the rest (unverified and soft wishes, any-of / none-of groups, beds, a reset) ride along unchanged and are listed in the sheet; a reset draft is compared against an empty form so nothing it keeps is lost. If the model fails, the reply says so and the filters stay; valid-but-empty output gets `FIXED.draft_other` (filters unchanged, use the buttons). Dates are neither searched nor kept while `RAG_DATED_SEARCH` is off (A9). Buttons have their own per-minute limit and do not count against the daily AI limit. A typed message counts against the daily limits only if it reached a model (`Allowance` in `route.ts`: reserved first so a burst cannot overshoot, given back when the finished turn made no model attempt), so a billing pause never uses up a guest's day; the per-minute limit still counts every typed message. A bundle older than `caps: 2` gets the safe reply. The canary (`RAG_V2_PERCENT`) is decided once, by `chatIdentity` + `pilotLive` in `runtime.ts`, for `/api/chat`, `/history` and `/config`: a visitor who gets the safe reply is never offered the filter controls or shown search state. Bundles older than 2026-11-28 send no identity to `/config` and get the controls only while the canary is everyone, so set it below 100 only after the current bundle has been live a day (it is cached up to 24 h). `chat` mode (reading applied directly) is held to the release gates.

Three places name the intents and must stay in lockstep: the fast-path regexes and the `INTENTS` list in `understand.ts`, and the `switch` in `pipeline.ts`.

`RAG_PIPELINE` defaults to `safe` (a fixed "use site search / Support" reply, no model) and that is the rollback target. The pre-pipeline retrieval is kept only as a measurement baseline in `eval/baseline/v1.ts` — it is not a mode, and must never be wired back in as a fallback: it cannot enforce a budget.

### Admin determination is database-driven

`isAdminPayload()` in `src/lib/jwt.ts` is the legacy sync check (JWT claims + env-var allow-list). New code must use the async `resolveIsAdmin(payload)` instead — it adds a Mongo lookup against the `admins` collection (per `server.me/models/Admin.js`: `_id: ObjectId(userId), role: "admin", "status.banned" !== true`) so the chatbot picks up admins managed in the DB without env-var maintenance. Cached 5 min per userId in-memory. `ADMIN_EMAILS` and `ADMIN_USER_IDS` env vars are emergency overrides only — production should leave them blank. Callers: `supportSocket.ts` connection auth (line ~245) + four admin-only HTTP routes.

### Property visibility is gated on `status: "active"` — three layers, must stay in lockstep

The chatbot only embeds and surfaces properties whose `status === "active"`, mirroring the filter `user.website` uses to render its public catalogue. This keeps the chat in agreement with what users actually see — a property they can't book on the site won't be recommended in chat. The rule is enforced in **three independent places**:

1. **Embed time** — `embedAndSaveProperty` in `src/lib/embedder.ts` early-returns and **unsets** the embedding when `status !== "active"`. So flipping a property to inactive in `server.me` propagates via the change stream and removes it from search within seconds.
2. **Boot time** — `runCatchUpSync` in `src/workers/catchUpSync.ts` only iterates `{ status: "active" }` documents.
3. **Search time** — chat results now come from `server.me`'s public search, which applies the site's own rule (`status: "active"` and not banned), and `requirements.ts` re-checks `status` on every row. The embeddings are still maintained by layers 1 and 2 (for a future semantic ordering step); if `$vectorSearch` is ever used at request time again it must carry `filter: { status: "active" }`.

If you ever broaden visibility (e.g. include `pending` or `archived` properties), update all three in the same change. Touching one creates a silent inconsistency that's hard to spot in tests.

### The AI kill-switch gate must stay the FIRST statement in `POST /api/chat`

`src/lib/aiToggle.ts` backs an ops switch (admin.site → Settings) that turns the
AI assistant off when the business is closed, so Gemini/Groq/xAI stop costing
money. Three things make it real rather than cosmetic:

1. **`src/app/api/chat/route.ts` checks it before anything else** — before the
   rate limiter, the search-state read, the model call and the catalogue search. The widget
   bundle is loaded cross-origin and anyone can POST directly, so this check is
   the only actual spend guarantee. Do not move it below the rate limiter "for
   consistency": `isAiEnabled()` is cache-backed and cheaper than the limiter's
   own bookkeeping. `src/app/api/chat/history/route.ts` carries the same gate.
2. **The fail-closed contract has three rules** — missing settings doc → enabled
   (backward compatible); read error → disabled; **expired cache + failed re-read
   → disabled, never re-serving a stale `true`**. Rules 1 and 2 look similar
   enough that a refactor could merge them and silently leave billing on during a
   Mongo outage. `npm run verify:ai-toggle` asserts all three — run it after any
   edit to that file.
3. **Client-side is UX only.** `ChatWidget` hides the AI tab, drops the segmented
   control when no tab remains (a lone tab still shows — see `showModeTabs`),
   filters AI-routing tiles out of the menu
   drawer, and — because Support requires login — shows a sign-in CTA for
   anonymous visitors rather than an empty panel. None of it is trusted; a forged
   config response still gets a 403.

Two coupled details worth remembering: the anonymous-user guard
(`if (!loggedIn && mode === "support") setMode("ai")`) is conditional on the AI
tab existing, otherwise it strands users on a hidden tab; and the support socket
only connects when the user is actually logged in, otherwise every logged-out
visitor would retry a doomed handshake. `/embed/widget.js` is cached 5 minutes in
prod, so an already-open tab can lag a flip — `useChat` watches for the
`ai_disabled` 403 and corrects the UI immediately.

### The Support and Messaging switches (`featureToggles.ts`) are FAIL-OPEN — the opposite of the AI switch

Admin.site → Settings has two more switches next to the AI one: **Support Chat** (`settings/support-chat`) and **Guest ↔ Host Messaging** (`settings/messaging`, enforced by `majestic-chat`, which reads the same document from the shared database — keep the id and the `enabled: boolean` field in lockstep with `majestic-chat/.../lib/messagingToggle.ts`). Written by `POST /api/admin/chat-features` (admin-only via `resolveIsAdmin`, strict `{ feature: "support"|"messaging", enabled: boolean }`, no coercion); read publicly via `GET /api/chat/config` (`aiEnabled`, `supportEnabled`, `messagingEnabled`, additive). The first read of a process logs which database the switches live in (`[featureToggles] switches live in database …`): `majestic-chat` reads `messaging` from its `MAIN_DB_NAME`, which must be that same database or admin flips are never seen there.

- **Fail-open on purpose**: absent / malformed / unreadable → ON, and a failed read keeps the last value (an admin's OFF survives a blip). The AI switch fails closed because it guards a bill; these guard availability, and hiding every customer's inbox on one failed read is the outage they exist to prevent. `npm run verify:feature-toggles` asserts it; `verify:ai-toggle` still asserts the opposite for AI — never merge the two modules.
- **Support enforcement** (`supportSocket.ts`): the handshake refuses customers (JWT or guest session) with `data.code = "support_disabled"` — **agents are never refused** (the console must stay usable to read the backlog); a `socket.use` gate refuses every packet of a connected customer using `peekFeature` (last value, synchronous, so packet order is kept); a 5 s sweep (skipped while the namespace is empty; it re-reads the switch itself because this module instance has a different cache from the admin route's) emits `support:disabled` and drops customer sockets (a flip lands within ~5 s); `GET /api/support/conversations/:id/transcript` answers 503 to non-admins. The client (`useSupportChat`) treats `support_disabled` / `support:disabled` as terminal for the page load: no reconnect, no new socket (including the manual `io server disconnect` reconnect).
- **Widget UI** (`ChatWidget.tsx`): `supportEnabled` defaults to `true` (fail-open) and comes from the config; `supportAvailable = isLoggedIn && supportEnabled`; Support tab and its menu tile disappear; AI on + Support off → AI tab only; **AI off + Support off → no launcher and no panel at all** (`widgetOff`). Client-side is UX only — the server gates are the control.

### Auto-ack must NEVER use AI

The auto-ack on first user message is a **static template** chosen between `isFirstAck`'s two strings. It must not be:
- An LLM call (latency + cost + unpredictable wording)
- A client-side fake (would not show up in the admin's view + wouldn't survive reload)

Keep it server-side, persisted, and templated.

## Common pitfalls

### Production runs a precompiled bundle — two invariants to keep

`npm start` runs `node dist/server.cjs`, built by `scripts/build-server.mjs`
(esbuild). It used to run `tsx server.ts`, i.e. a TypeScript compiler stayed
resident for the life of the process. Removing it cut idle RSS by **25%**
(197 MB → 148 MB measured locally, A-B-A'd against machine drift), which matters
because Railway bills this service overwhelmingly for memory. A useful side
effect: production no longer depends on a devDependency at *runtime*.

Two things will silently break it:

1. **No module-scope `process.env` reads in `server.ts`'s import graph.**
   `server.ts` calls `loadEnvConfig()` and then `await import()`s the workers
   specifically so env is populated first. Today every `process.env` read in
   `src/workers/**` and `src/lib/**` is inside a function body, which is what
   makes bundling safe — esbuild wraps dynamically-imported modules in lazy
   initialisers, so they still evaluate after `loadEnvConfig`. If you add a
   `const X = process.env.Y` at module top level, you reintroduce the ordering
   bug the dynamic imports exist to prevent.

2. **Output must stay CommonJS.** ESM output was tried and fails at boot twice:
   `loadEnvConfig` is undetectable as a named export from the CJS `@next/env`,
   and after bundling that package you get `__dirname is not defined in ES module
   scope`. `tsx` hides both behind its `require` interop. Don't "modernise" the
   build to ESM without re-running the boot test.

`dist/` is gitignored; Railway regenerates it via `npm run build`. If you change
`server.ts` or anything it imports, `npm run build:server` before `npm start`, or
you'll run a stale bundle and wonder why your change did nothing.

### Bundle cache during dev

`Cache-Control: max-age=300` on `/embed/widget.js` (set in `next.config.ts`) is great for prod but causes "why isn't my change showing up" confusion locally. The user.website's `layout.tsx` adds `?t=${Date.now()}` to the bundle URL in dev specifically to bust this. If a colleague reports "I don't see my latest change," check that they have the dev cache-buster.

### `mongodb+srv://` SRV lookup can fail at the OS level

Some Windows/ISP DNS configurations refuse TXT record queries for Atlas SRV hostnames (`EREFUSED`). Mongoose 7 in `server.me` is particularly susceptible. The fix is **at the OS / env level** — switch DNS to 8.8.8.8 OR convert the URI to the direct (non-SRV) form. See `server.me/.env`'s commented direct URI for the pattern. This service uses the modern `mongodb` driver (v6) which is more resilient, but if you see `queryTxt EREFUSED`, look at the resolver, not the code.

### A conversation starts with the customer's first message

Opening the Support tab writes nothing for current bundles (`auth.proto: 2`): the join is a draft (`conversationId: null`) and the first `support:message` with `conversationId: null` creates the conversation. Only then does it reach the agents' inbox (`support:new-conversation`, exactly once). Old bundles (no `proto`) still get an eager conversation on open, marked `createdBy: "legacy-open"` and kept out of the inbox until a customer message lands — remove that path only once no such empty documents appear for 2 weeks (the bundle is cached up to 24 h with stale-while-revalidate).

"One open conversation per customer" is enforced by the database (`activeKey` + the unique partial index `active_key_unique`), not only by the in-process identity lock — keep `activeKey` on every insert, remove it on resolve / claim, restore it on reopen only if free.

### `support:start` is never dropped

The old 500 ms debounce dropped starts (a Skip → Start fresh within 100 ms stranded the widget). Starts are now coalesced — one runs, one waits, every start is answered — and the connection-time join answers the client's first start. Don't reintroduce a drop.

### Names come from `users` / `admins`, never the token

The JWT `firstName` claim is what was true at sign-in and lives 7 days; `userFirstName` / `assignedAdminName` on a conversation are what was true when written. An admin can rename users (Users grid) and themselves (Settings) at any time, so anything that shows a name reads it from the record via `src/lib/supportNames.ts` at the time of the action or the read, with the stored copy only as the fallback for a deleted record. Already-written lines (system chips, transcript lines) keep their names — they are history. Customers only ever receive an agent's FIRST name.

### Locks and queues never release on a timer

`withKeyLock` releases only when the holder's work settles; a waiter gives up after 10 s without running. Releasing on a timeout would let the next holder overlap a database write that is still running. Work under a lock uses `maxTimeMS` so it can't hang, and the client (`mongodb.ts`) fails an unreachable database in 5 s (server selection, connect). **No socket timeout:** the listing change stream's first wait after a restart scans the oplog from its saved position (21 s in production), and an 8 s socket timeout killed it on every restart (2026-11-28 release, fixed the same day). Instead, every database call a customer's request waits on goes through `bounded()` (`src/lib/bounded.ts`, 2.5 s): the AI and feature switch reads, history, and each state read/write of a turn, after the first failure of which the turn stops asking. State writes are bounded by time only, never by the turn's signal, so a customer who leaves mid-turn still has what they asked kept. Worst measured stall: 8.5 s, inside the 9 s turn deadline (staging drill 2026-11-28). The per-socket queue is bounded (32) and drops tasks that waited more than 15 s — unstarted, so nothing overlaps either.

### The archive is best-effort after the ring

If all three archive retries fail, the message lives only in the 500-message ring and is lost from the transcript if the ring later evicts it (`archive insert FAILED` in the logs). Known and accepted; a repair job could only copy what is still in the ring.

### Concurrent first auto-acks were possible — now atomic

The auto-ack is appended with a filter that includes `assignedAdminId: null` and `$nor: [{ messages: { $elemMatch: { from: "system", kind: "auto", createdAt: {$gte: fiveMinAgo} } } }]`. If you change the auto-ack flow, preserve the atomic guard or expect race-condition double-fires under load (`verify:support` group `life-race` checks it).

### Don't return `list[0]` on CORS rejection

`src/middleware.ts` returns `null` (omits the ACAO header) when an origin is rejected. The browser then blocks the response cleanly. Earlier code returned `list[0]` which sent a wrong-but-valid header that's silently misleading. Don't reintroduce that pattern.

### The widget must out-stack the host page's chrome

`<majestic-chat-widget>` is `display:inline` with `z-index:auto`, so it creates
**no stacking context** — the panel's `position:fixed` children compete directly
with whatever the host page puts on screen. The panel stack used to top out at
`z-50`, and user.website's header is `fixed ... z-[1002]`, so the header painted
over the panel's top ~38px: on `<lg` the panel starts at y=8 under a 46px header,
which sliced off the avatar and the minimise/close controls. The backdrop lost
the same fight, so the header stayed bright white while the rest of the page
dimmed. It affected every viewport (desktop panel starts at y≈28 under a 77px
header); it was just most obvious on mobile.

`Z_BACKDROP` / `Z_PANEL_STACK` in `ChatWidget.tsx` now claim the near-max band
third-party widgets conventionally use (Intercom sits at 2147483000). Two rules:
keep the backdrop exactly one below the panel (their order is what makes
click-outside-to-close work), and keep both as **literal strings** — Tailwind
only emits arbitrary utilities it can find verbatim in `src/embed/**`. Don't
"fix" this by offsetting the panel below the header instead; the host header
height varies per site and per route, and the panel is meant to overlay it.

### The launcher steps aside while the host page has a modal up

Out-stacking the host (above) has a cost: the launcher paints above the host's
own sheets and dialogs. On user.website's stay page the "Check availability"
sheet (a bottom sheet from the sticky price bar) had the launcher floating over
its right edge — on the guest stepper's "+" and on the primary button — so a
guest changing the number of guests tapped the chatbot instead.

`useHostModalOpen` (`utils.ts`) hides the launcher — the same fade-and-shrink as
when the panel opens, 200 ms out / 300 ms back, no shrink under reduced motion —
while the host page has a modal up. It reads what a modal does to the page, not
any one site's markup, so a sheet added later is covered:
- `<body>` pinned (`position: fixed`), or `overflow-y: hidden|clip` on `<body>`
  or `<html>`, or react-remove-scroll's `data-scroll-locked` (Radix dialogs and
  sheets, vaul drawers);
- or, for a modal that cannot lock scroll, the explicit opt-in
  `data-majestic-chat-hide-launcher` on `<html>` (host sets and removes it).

Invariants — each one was a bug or a near miss while building this:
- **Do not use `aria-modal`.** It reads naturally, but user.website's sheets
  unlock the page and unmount a beat later, deep in the React tree; that removal
  fires no mutation on `<html>`/`<body>`, and observing the whole subtree of a
  React app is the cost this design avoids. The launcher stayed hidden after
  the sheet closed. Everything the hook reads is an attribute of `<html>` or
  `<body>`, watched by two attribute-only observers (no `subtree`, no
  `childList`), coalesced to one read per frame.
- **Read only overflow-y.** The site keeps `overflow-x: hidden` on body and html
  permanently, which computes overflow-y to `auto`; reading the `overflow`
  shorthand would hide the launcher on every page.
- **The hook is paused while the panel is open** (and on routes the widget hides
  on). The panel's own scroll lock (<lg) is indistinguishable from a host modal;
  the launcher is out of the way then anyway. It re-reads when the panel closes,
  after the lock is released, so the launcher comes back.
- The launcher is `invisible` while hidden: not a Tab stop, takes no taps; the
  halo and the new-conversation dot are unmounted rather than animating unseen.

The launcher itself keeps one fixed offset (`LAUNCHER_OFFSET`): above the sticky
bottom bars on phones (112–176 px from the bottom), bottom-right on md+. Its
size and position are the `--mc-launcher-*` variables in `styles.css` (48 px
on phones, 12 px from the edge, `7rem` + safe-area inset up; 64 px / 24 px on
md+; 44 px on touch screens <= 500 px tall; landscape phones >= 600 px wide sit 72 px
up, just above the 65 px tab bar). Never go under 44 px, and keep a phone
offset >= the tallest host bar (stay page price bar 97 px + inset). A
collision audit (12 routes x 14 viewports, 320 px phones to 1920 px desktops and
two landscape phones, at the top, middle and end of each page) found no fixed or
sticky control under it on any phone, and on tablet/desktop only one transient
case: the stay page's sticky booking card at first paint on tablet portrait
(768x1024: a corner of "Check availability", 8% of the launcher), gone after the
first scroll because the card then sticks above it. What passes beneath the
launcher while scrolling (cards, carousels, map controls) is ordinary content
and is accepted. The one place content cannot scroll away is the very end of a
page: user.website's footer has `pb-24` so its last row (the social icons) ends
above the launcher's band (without it the WhatsApp link was partly covered on
320 px phones). If another site embeds this widget, give its footer the same
clearance.

### The launcher mascot greets once per page load, then only blinks

`src/embed/Mascot.tsx` draws the launcher: an orb whose visor and sparkle eyes
are projected onto the sphere (`geometry()`), so a head turn curves and hides
them like a real ball. The owner's rules, each asserted by
`tests/pw-final/mascot-check.cjs` on Chromium, WebKit and Firefox and by
`npm run verify:mascot` (pure math):
- **The greeting (spin in 180° from the back, look around, nod with peak eyes,
  ~6.7 s) plays once per page load** (`greetedThisLoad`, module scope): not
  again on client-side navigation, a hidden route and back, or after the panel
  closes. Interrupted (panel opened, host modal) it snaps to the rest pose.
- A page loaded in a background tab waits and greets when first shown.
- After it: one slow blink every 5–7 s, a ~0.45 s rAF burst; nothing runs while
  the launcher is hidden or the tab is in the background. No rAF loop may run
  continuously.
- `prefers-reduced-motion`: still face, no greeting, no blinks, no float.
- Attributes are set imperatively from refs (no React render per frame);
  `Mascot` is memoised on `active` so a parent render never resets them.
- No `url(#id)` gradients in its SVG (fragile inside a Shadow Root): plain fills.
- `region()` cuts the visor where it goes behind the sphere and follows the
  sphere's outline there. Never "pin" hidden points to the outline instead: once
  the visor wraps past the back of the head (early in the spin) the pinned points
  land on the far side and the visor covered the whole orb, a dark disc for
  ~0.1 s that the owner caught on a phone. `verify:mascot` now checks the drawn
  visor area every 5 ms (never bigger than facing you, never jumping).
- Hover/focus rules in `styles.css` override the animated opacity attributes
  and declare their transition only in the hover state, so the script's per-frame
  changes are never eased; they are off while `data-greeting` is set.

The same component is in the panel: the **AI header** (`intro="hello"`: a
twinkle and a nod each time the panel opens, then slow blinks; nothing while
closed) and **every AI reply avatar** (`still`: never moves; they share one
cached rest geometry). The **Support** tab keeps its headset icons in the
header and on agent replies: the mascot is the AI assistant only.
`--mc-orb-size` sets the orb's size outside the launcher.

`public/robot.png` (the old launcher image) is no longer used by this bundle;
keep it until cached older bundles (up to 24 h) have aged out, then delete it.

### Mobile keyboard + scroll lock is interlocked — don't simplify

Three pieces in `src/embed/ChatWidget.tsx` work together on `<lg` viewports and breaking any one of them re-opens UX bugs the user has already reported:

1. **`visualViewport` listener** sets `--mc-vvh` (height) and `--mc-vvtop` (offsetTop) on the `<majestic-chat-widget>` host element. The panel reads these via `top-[calc(var(--mc-vvtop,0px)+8px)] max-lg:h-[calc(var(--mc-vvh,100dvh)-16px)]` so it shrinks and follows the visible area when the on-screen keyboard opens. Removing this re-introduces the "header scrolls off-screen when keyboard opens" bug. The same listener sets **`data-typing`** on the panel — directly on the element, not React state, so it lands in the same frame as the new size — while a field of the panel has focus and the visible area has lost ≥ `KEYBOARD_MIN_PX` (vs its height with nothing focused, or vs `innerHeight`). The `data-[typing]:` / `group-data-[typing]/panel:` classes then make the panel WhatsApp-style: edge to edge, one-row header, no tab strip, no footer caption (on the owner's phone that took the conversation from ~77px to ~180px above the keyboard). A hardware keyboard takes no height, so it never triggers. It's a layout effect, so an open is sized before its first paint. **Android Chrome's visual viewport is too tall while the keyboard is up** on this site: with `viewport-fit=cover` Chrome draws under the navigation bar and reports it as `env(safe-area-inset-bottom)` (24px on a Pixel); with the keyboard up it drops that inset to 0 but still counts the bar in `visualViewport.height`, so the viewport reaches 24px behind the keyboard and the message box's lower edge disappeared under it. `--mc-vvh` therefore takes off whatever bottom inset the keyboard made disappear (measured at rest through the hidden `insetProbeRef` span). iOS keeps its inset while typing and its viewport is correct, so nothing is taken off there. Measured on the emulator's real Gboard: keyboard top 469px, reported viewport 494px. **While the panel is open the widget sets `interactive-widget=resizes-content` on the host's viewport meta** (the host's exact string comes back on close), so the keyboard resizes the page and the visible height is the real one. Without it, Chrome's 2026 bottom toolbar (flag `android-bottom-bar`, also the address bar at the bottom) reported the keyboard 28-60 px higher than it is in both `visualViewport` and `navigator.virtualKeyboard`, and a band showed between the message box and the keyboard. The 24 px inset correction above applies only when the page kept its size under the keyboard (`innerHeight` != `visualViewport.height`). Viewport events are re-read every frame for `VIEWPORT_SETTLE_MS` (a last event can arrive before the keyboard settles), `window` `resize` is listened to as well, and while typing a white box-shadow continues the panel 120 px down as a last safety net. Verified with real keyboards on emulator Chrome 155 (classic top bar, address bar at the bottom, new bottom bar) and Chrome 109: the message box and the filter sheet sit flush on the keyboard.
2. **Body lock uses the `position: fixed; top: -scrollY; width: 100%` pattern**, NOT just `overflow: hidden`. iOS Safari and Android Chrome (with the default `interactive-widget: overlays-content`) let the user drag-scroll the host page even with `overflow: hidden`. The fixed-body pattern is the only thing that actually freezes the page; `window.scrollTo(0, lockedScrollY)` on cleanup restores the user's scroll position.
3. **Global `touchmove` blocker on `document`** — `passive: false` listener that `preventDefault`s any touchmove whose `composedPath()` doesn't include `messagesScrollRef.current`. Without this the user can still finger-drag the host page from the panel header / input wrapper / backdrop. The messages list is the only scrollable region; everything else is locked.

All three are gated by `matchMedia("(max-width: 1023px)")` so desktop is untouched. The backdrop covers `inset-0` on every viewport and is transparent on desktop (`lg:bg-transparent lg:backdrop-blur-none`) so click-outside-to-close works everywhere — don't add `lg:hidden` back to it.

When the message list changes height (keyboard, header folding, the agent's "is typing…" row), a reader **following along** — within `FOLLOWING_PX` of the end, per `fromBottomRef` — stays at the end, so the latest message sits just above the field; a reader **reading back** is left where they are (bottom-anchoring them nudged the text on every typing-indicator toggle). A `ResizeObserver` does it after layout, before paint; the scroll-to-end on new messages is a layout effect for the same reason (no frame of a fresh history shown from its top). Scroll the list element itself — `scrollIntoView` can pan the whole page on iOS. Browser scroll adjustments during a resize (WebKit clamps before the observer runs) are ignored by the height check in `onMessagesScroll`; don't remove it.

### The message box is never `disabled`, and open/close never flickers

Two rules the phone experience depends on:

- **Never disable the composer** while sending or (re)connecting. A disabled `<textarea>` loses focus, and on a phone that closes the keyboard after every message. Sending is gated by `canSend` instead (Enter and the send button are no-ops, the text stays), and `support.sendMessage` returns whether it went out so a message is only cleared once it did. The send button's `onMouseDown preventDefault` keeps focus in the box when it is tapped — and for that the button is never `disabled` either, only `aria-disabled`: a tap on a disabled button moves focus off the box without ever reaching `onMouseDown`.
- **Nothing inside the panel changes while it fades out.** The support socket hangs up, the menu resets and the typing layout / `--mc-*` vars are cleared only after `PANEL_GONE_MS`; reopening inside that window carries on. Otherwise the fading header flipped to "Connecting…", the drawer slid away and the panel snapped to another size mid-fade. Related: the backdrop is always mounted and fades (it used to unmount in one frame); `visibility` is transitioned only on the hide side (a panel that is `visibility: hidden` at the start of its open transition can't take focus); no `transition-all` on anything that must take focus right after a visibility change — it eases the inherited `visibility` too. "Connecting…" only shows after `CONNECTING_GRACE_MS` (3 s — a production reopen takes ~1–2.5 s to reconnect from India, far longer than localhost; tune it against production), and the starter prompts wait for the conversation (`support.joined`, `aiHistoryReady`) instead of flashing before a returning visitor's history replaces them.

### The panel's conversations belong to whoever is signed in

The site signs people in and out **without a page reload**, and the widget keeps both conversations in React state while it's closed (so reopening shows them at once). On every open, a layout effect compares the auth token with the one from the previous open; if a signed-in person's token has gone or changed, `support.forget()` and `forgetAi()` drop their conversations and the draft before anything is painted (a guest who signs in keeps the guest thread — it belongs to the device). `forgetAi` bumps a generation counter so an AI history request still in flight can't land in the next person's thread, and aborts a reply still streaming. The panel also **closes whenever the route hides the widget** — the site sends an expired session to /login while the chat may be open, and a panel that came back already open would skip the check. Keep both if you ever cache more per-person state in the widget.

### "Start fresh" hides the conversation for good

The widget's Start fresh (`reset: true`) clears the panel and the saved search, and `POST /api/chat` also writes a `role: "reset"` marker to `ai_chat_messages` for that person (awaited before the turn). `/api/chat/history` returns only messages after the latest marker, so reopening the chat or a new page load no longer brings the old conversation back (it did until 2026-11-28; the old rows stay in the collection for the record). Markers move with the guest's history on sign-in like any other row. A typed "new search" resets only the search, not the conversation.

### Menu links on phones wait for the Back step

On phones and tablets the open panel owns a history entry (the Back sentinel), and closing the panel steps back over it. That step cancels any navigation already started, so the menu's links (`onNavigate`: FAQs, Cancellation policy, My bookings, Wishlist) did nothing on phones until 2026-11-28. `onNavigate` now closes the panel, waits for the `popstate` of that step, then navigates (1.5 s fallback). Stay cards are plain links that never close the panel, so they are unaffected. In filters mode the menu's "Find a stay" opens the filter editor; there is no "Plan a weekend" tile while travel advice is off.

### Focus and keyboard

The panel is a modal dialog (`role="dialog"`, `aria-modal`, labelled by the header title): opening moves focus to the panel itself (never the message box — that would pop the phone keyboard), Tab/Shift+Tab loop inside it, and Esc closes it (unless the menu is open, which closes first) without the key reaching the host page. On close, focus returns to the launcher only after a keyboard close (Esc, or Enter/Space on the close button); after a tap, click or Back gesture it's just released — moving it from the message box would light the launcher's `:focus-visible` ring on phones. The menu drawer does the same for its own open/close and is `inert` + `invisible` while closed.

### Railway does NOT inject user env vars during build

Railway's Nixpacks build only ARGs Railway-system vars (`RAILWAY_*`, `CI`, etc.) into the Dockerfile — **user-defined vars like `MONGODB_URI` are NOT available during `next build`**. Anything that reads `process.env.MONGODB_URI` (or any other secret) at module-load time will see `undefined` during the build's "Collecting page data" pass and crash. The fix is to make the access lazy: defer the `new MongoClient(uri)` until the first runtime `await`. See `src/lib/mongodb.ts` — the default export is a thenable, not an eager Promise. Don't revert that to the eager pattern; it'll work locally (where `.env.local` is loaded) but blow up on Railway. Same principle applies to any new module-level service init.

### Change stream resume token can expire — worker now self-heals

`src/workers/changeStream.ts` persists the resume token to `changestream_resume.{_id: "listingproperties"}` after every successful event. Atlas's smaller cluster tiers rotate the oplog aggressively when idle, so any deploy gap longer than the oplog window invalidates the token. The worker catches `MongoServerError` code 286 (`ChangeStreamHistoryLost`) specifically and clears the persisted token before the next iteration — the restart loop then runs `coll.watch` without `resumeAfter` and starts fresh from "now". Don't remove this branch; without it, every cold deploy after a long idle period hits an infinite 5s sleep loop in the worker. Property changes that happened during the restart-loop window can be backfilled with `POST /api/admin/embed-all` (admin JWT required).

### AI provider fallback chain — cascade contract

`src/lib/rag/llm.ts` walks the ordered chain in `LLM_CHAIN` (`provider:model,…`; default in `runtime.ts`, the proposed production routing: Groq `openai/gpt-oss-120b`, then `qwen/qwen3.8-27b`; Hindi / Hinglish the reverse) and makes **at most two model attempts that can take time per request**; a rate-limit refusal (429, answered at once) does not use one up, so a chain whose first models are out of quota still reaches the next one (measured in the 2026-11-27 browser check: with both Groq models at their daily cap, the third entry was never tried). The next entry is tried on **any** failure (HTTP error, timeout, text that is not JSON), not just 429: the models this service was first built on were retired, and a retired model answers 404. Per-entry circuit breakers skip a model that answered 429 (for the provider's retry delay), 401/403/404 (10 min) or failed 3 times in a row (30 s). **Billing** (402 `billing_error`, a 429 or 402 whose `error.details.error_code` is a spend limit, or the older 400 "credit balance is too low"; `failureKind` in `llm.ts`, read from the SDK's `err.type` / `err.errorCode`, never the wording) rests the entry **10 min** and logs `[llm] … paused 10 min (check credit / spend limit)`; a 529 overload rests it 30 s at once. **Content failures never open a breaker**: a refusal or text that is not JSON is that one message's failure, and counting it would let one guest pause the model for everyone. While an entry rests, `proposeJson` answers "unavailable" without a call and without touching the daily cap or the guest's daily allowance, so drafting replies "use the filter buttons" at once; the first message after the rest calls the model again, which is how a credit refill is picked up (no restart, no flag). Production (2026-11-28): `LLM_CHAIN=anthropic:claude-haiku-5-5`, `LLM_CHAIN_HINGLISH` unset (Haiku only, every language), `RAG_AI_DRAFT=on`. Only models named in the chain are ever called; nothing switches to a paid model by itself. Each attempt is reserved against the daily cap (`ai_usage`, in the database so a restart cannot reset it; an unreadable counter refuses the call) and has its own timeout under the route's single 9-second deadline. If no attempt succeeds the customer gets "busy" (quota) or "I couldn't process that" (failure); an answer that is valid JSON but unusable (e.g. `{}` to an injection attempt) gets "I'm not sure I understood". No search runs on stale state.

Free tiers (dev keys, measured 2026-11-26): Groq ~1,000 requests and 200,000 tokens per day **per model** (≈120 messages per model per day at ~1,600 tokens each); Gemini 500 requests per day per model, often 503. Groq's terms bar training on inputs and keep none by default; Gemini's **unpaid** tier allows human review of inputs, so it is not in the default chain. `gemini-2.5-flash-lite` is closed to new keys (404); gpt-oss models need `reasoning_effort: "low"` for JSON mode (set in `llm.ts`). Re-run the live benchmark (`eval/README.md`) before changing the chain.

Optional `LLM_CHAIN_HINGLISH` routes Hindi / Hinglish messages (any Devanagari, or one word from the list in `llm.ts` that is never English) to a second chain with the same two-attempt and breaker rules (`routeChain`). The router reads the current message only, so an English follow-up in a Hinglish conversation goes to `LLM_CHAIN`. With `LLM_CHAIN` set and this unset, one chain serves everything; with both unset, the code default routing applies.

### Dates are India's, and they live in the search state

`src/lib/rag/dates.ts` computes "today" in `Asia/Kolkata` — never from the server clock (Railway runs in UTC, which is still yesterday in India until 05:30). Dates stay in the per-identity search state until the customer changes them, the state expires (30 idle minutes), or they pass (`revalidate` drops them and the reply says so). The model resolves relative dates from the India date it is given; `crossCheck` refuses dates from a message with no time word, past dates, a lone date, and impossible dates.

### Input `maxLength` mirrors server `MAX_MESSAGE_CHARS`

The chat input in `src/embed/ChatWidget.tsx` carries `maxLength={2000}` matching `MAX_MESSAGE_CHARS` in `src/lib/moderation.ts`. Keep these in sync. Drift means a user pasting a long transcript sees a generic "trouble connecting" banner instead of natural truncation, because the server returns a bare 400 and the frontend renders the same error for any non-200. If you raise the server cap, raise the input cap; if you lower one, lower both.

### Chatbot root path redirects to `majesticescape.in`

`next.config.ts` has an explicit redirect `source: "/" → destination: "https://majesticescape.in"` (307). When the service is hosted on a branded subdomain like `chat.majesticescape.in`, this prevents users who type the URL directly into a browser from seeing the bare Next.js placeholder page. Bundle (`/embed/*`), API (`/api/*`), and Socket.IO (`/socket.io/*`) paths are explicitly NOT matched and continue to serve normally. If you ever change this, make sure the rule is still root-only — broadening to `:path*` would break every API call.

### Support-socket `connect()` MUST guard on the whole socket, not just `.connected`

In `src/embed/useSupportChat.ts`, `connect()` bails with `if (socketRef.current) return` — meaning a socket exists in any state (connected, connecting, or reconnecting). The earlier guard `if (socketRef.current?.connected) return` let callers spawn duplicate `io()` sockets whenever the current one wasn't yet fully connected; combined with `ChatWidget`'s effect re-running every render (it depended on the whole `support` object — a fresh reference each render), each `connect_error → setError → render → effect → connect()` cycle created another orphaned socket. The browser eventually rejected them all with `Insufficient resources`, leaving the input/send button permanently disabled — most visibly "after the tab had been idle a while" because any disconnect kicked off the storm. Never weaken the guard; let Socket.IO's own reconnection (`reconnection: true`, `reconnectionAttempts: Infinity`) handle drops on the single socket instance. The matching ChatWidget effect destructures `support.connect`/`support.disconnect` (stable `useCallback`s) so the effect only runs on real `isOpen`/`mode` changes, not on every render.

### Visibility-change reconnect + `io server disconnect` recovery

Two paths the default Socket.IO client doesn't recover from cleanly:

1. **Heavily-backgrounded tabs**: browsers throttle background timers; on refocus the reconnection backoff can leave the input disabled for several seconds. `useSupportChat` adds a `document.addEventListener("visibilitychange", …)` that calls `socketRef.current.connect()` immediately when the tab becomes visible again, so the reconnect doesn't wait out the backoff.
2. **`io server disconnect` reason**: Socket.IO will NOT auto-reconnect when the disconnect reason is `io server disconnect` (server-initiated drop). The `disconnect` handler now `sock.connect()`s manually for that reason.

If you ever simplify the `disconnect` handler back to `setIsConnected(false)`-only, you reintroduce both bugs.

### Atlas Vector Search `filter` requires the field be indexed as `type: "filter"`

The chat route no longer runs `$vectorSearch` (results come from `server.me`'s search — see "The search pipeline"), but the index and the embeddings are still maintained, and any future `$vectorSearch` must filter on `{ status: "active" }`. For that filter to actually narrow results, the **Atlas vector index** must include `status` as a `type: "filter"` field — not just the vector field. The index creator script (`scripts/createVectorIndex.js`) includes it; the prod cluster's index was manually created via the Atlas UI without the filter field at one point and silently returned **zero** results for every search (the AI then hallucinated property names from its training, which looked like a totally different bug). If a new cluster is provisioned, run `npm run atlas:create-index` against it — don't hand-create the index in the UI.

### Gemini embedding-model access is per-Google-project, separate from text generation

A Gemini API key valid for `gemini-2.0-flash` (text generation) can still return `403 PERMISSION_DENIED` from `gemini-embedding-001` — embedding access is granted at the Google Cloud project level and isn't automatic on every key. Symptom: the chat replies in text but vector search returns nothing → no property cards. Test a new key with a quick `curl -X POST .../gemini-embedding-001:embedContent?key=…` before deploying; if it 403s, create the key inside a project that already has embedding access (or contact Google support).

### Sister page `admin.site/src/app/dashboard/support-chat/page.jsx`

The admin reply console connects to the same `/support` namespace via its own socket. Its inbox is paged (`support:admin-init` → `support:admin-more` by cursor), rows keep the highest `rev` and take absolute state from events (never count locally), and read receipts send `{seq, messageId}`. Two patterns mirror what's in `useSupportChat`:

1. On `connect` (initial AND every reconnect), if a conversation is open (`activeIdRef.current`), the admin re-emits `support:fetch-history` + `support:assign`. The server's `handleAssign` short-circuits to a silent `socket.join(room)` when the same admin is still assigned, so re-emitting is a no-op room-rejoin. Without this, a reconnect leaves the fresh socket only in `ADMINS_ROOM` — live messages for the open thread silently stop until the admin clicks away and back.
2. The same `visibilitychange` reconnect listener.

Changes to socket plumbing here (new server events, namespace rename, etc.) must be mirrored on the admin side. The two pages don't share code — keep them in lockstep manually.

## Memory anchors

When making changes here, remember:

- **The user explicitly told us "we cannot have any gaps in the chatbot system."** Race conditions, stale state, and silent failures are bugs.
- **server.me is off-limits** for code changes. We can edit `server.me/.env` when the user explicitly authorises (e.g., the DNS workaround) but never the code.
- **user.website is one `<Script>` tag** for chat. Resist the urge to "just add a small thing there."
- **No commits unless explicitly asked.** Leave changes in working tree for review.
- **Test via Playwright MCP UI-driving** at `localhost:3000` / `localhost:3001`. Don't shortcut by calling `/api/*` directly — that misses the integration layer that is the actual product.

## When stuck

1. Check [`ARCHITECTURE.md`](ARCHITECTURE.md) — section numbers map to mental modules.
2. Check [`DEPLOY_NOW.md`](DEPLOY_NOW.md) — 1-page action checklist for deploying dev → prod (Railway + Vercel). Start here for any deployment question.
3. Check [`RAILWAY_DEPLOYMENT.md`](RAILWAY_DEPLOYMENT.md) — env vars + deployment quirks. The opening § 0 has the full per-environment env-var matrix. Use as reference for depth.
4. Check [`docs/PROD_AUDIT.md`](docs/PROD_AUDIT.md) — production readiness audit, why each env var matters, the four mandatory ones, and the smoke-check curls to run after any env change.
5. The user-facing widget UI lives in `src/embed/`, NOT in `user.website` (that was Phase A; pre-Phase A is irrelevant).
6. The Atlas Vector Search index is `listing_vector_index` on `listingproperties.embedding`, 3072 dim, cosine. Mismatched dimensions are the most common "chat returns nothing" cause.
