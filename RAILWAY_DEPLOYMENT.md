# Railway Deployment Guide

This guide walks you through deploying `majestic-escape-rag-ai-chat-widget` to **Railway** from scratch. By the end you'll have:

- A live URL like `https://chat-rag.majesticescape.in` (or a Railway-provided one)
- Auto-deploy on every push to `main`
- Always-on container with the Change Stream worker running 24/7
- Healthchecks + auto-restart on failure

If you're new to Railway, treat each section as a checklist — each one takes a few minutes.

> **One-time prerequisite:** the code must already be in a Git repository (GitHub, GitLab, or Bitbucket). Railway pulls from there.

---

## 0. Production + Staging checklist (read this first)

> **First time deploying?** Follow [`DEPLOY_NOW.md`](DEPLOY_NOW.md) — it's a 1-page action checklist that walks you from "Railway project created" to "live on prod" in order. Use this longer doc as the reference when you need depth on a specific section.

The chatbot supports two consumer environments out of the box:

| Environment | user.website origin | admin.site origin |
|---|---|---|
| **Staging** | `https://user.me.coderelix.in` | `https://admin.me.coderelix.in` |
| **Production** | `https://majesticescape.in` (+ `www.`) | `https://admin.majesticescape.in` |

The recommended setup is **two widget service deployments** (one per environment) so a bad bundle deploy on staging can't bleed into prod and the data stays isolated. If budget forces a single shared deployment, see *§ Single shared widget service* below.

### Staging deployment env vars

| Service | Where to set | Var | Value |
|---|---|---|---|
| widget service (Railway, staging) | Variables tab | `MONGODB_URI` | staging Atlas DB connection string |
| widget service (Railway, staging) | Variables tab | `JWT_SECRET` | **same as the staging server.me secret** |
| widget service (Railway, staging) | Variables tab | `GEMINI_API_KEY` | a Gemini Developer API key |
| widget service (Railway, staging) | Variables tab | `ALLOWED_ORIGINS` | `https://user.me.coderelix.in,https://admin.me.coderelix.in` |
| widget service (Railway, staging) | Variables tab | `ADMIN_EMAILS` | comma-separated staging admin emails |
| widget service (Railway, staging) | Variables tab | `NEXT_PUBLIC_PROPERTY_BASE_URL` | `https://user.me.coderelix.in` |
| user.website (Vercel, staging) | Variables tab | `NEXT_PUBLIC_CHAT_WIDGET_URL` | `https://chat.me.coderelix.in/embed/widget.js` |
| admin.site (Vercel, staging) | Variables tab | `NEXT_PUBLIC_SUPPORT_SOCKET_URL` | `https://chat.me.coderelix.in` |

### Production deployment env vars

| Service | Where to set | Var | Value |
|---|---|---|---|
| widget service (Railway, prod) | Variables tab | `MONGODB_URI` | prod Atlas DB connection string |
| widget service (Railway, prod) | Variables tab | `JWT_SECRET` | **same as the prod server.me secret** |
| widget service (Railway, prod) | Variables tab | `GEMINI_API_KEY` | prod Gemini key |
| widget service (Railway, prod) | Variables tab | `ALLOWED_ORIGINS` | `https://majesticescape.in,https://www.majesticescape.in,https://admin.majesticescape.in` |
| widget service (Railway, prod) | Variables tab | `ADMIN_EMAILS` | prod admin emails |
| widget service (Railway, prod) | Variables tab | `NEXT_PUBLIC_PROPERTY_BASE_URL` | `https://majesticescape.in` |
| user.website (Vercel, prod) | Variables tab | `NEXT_PUBLIC_CHAT_WIDGET_URL` | `https://chat.majesticescape.in/embed/widget.js` |
| admin.site (Vercel, prod) | Variables tab | `NEXT_PUBLIC_SUPPORT_SOCKET_URL` | `https://chat.majesticescape.in` |

### Why each consumer-side var is mandatory

- `NEXT_PUBLIC_CHAT_WIDGET_URL` on **user.website** — without this, the inline dev-loader fallback fires on the public domain and tries to fetch `https://<your-domain>:3003/embed/widget.js` (a port that isn't exposed publicly). The chat widget would silently fail to load. As of the production-readiness pass, the dev-loader now refuses to run on non-local hostnames and writes a clear `console.error` pointing at this exact var so the misconfig is obvious in DevTools.
- `NEXT_PUBLIC_SUPPORT_SOCKET_URL` on **admin.site** — admin.site connects directly to the widget service's Socket.IO `/support` namespace. Without this, the admin reply console can't reach the widget service.

### Single shared widget service (Pattern A) — only if cost-constrained

Combine all four origins into one `ALLOWED_ORIGINS` and point both staging+prod consumers at the same widget URL:

```
ALLOWED_ORIGINS=https://majesticescape.in,https://www.majesticescape.in,https://admin.majesticescape.in,https://user.me.coderelix.in,https://admin.me.coderelix.in
```

Tradeoff: staging users will hit prod data, and a bad bundle deploy hits both at once. Only acceptable for early-stage projects with low traffic.

---

## 1. Why Railway and not Vercel/Render?

This service has **two long-lived processes** that must never sleep:

1. The **MongoDB Change Stream worker** — listens for property edits and re-embeds within ~1 second.
2. The **Socket.IO `/support` namespace** — keeps live websocket connections to every active support chat.

Vercel's serverless functions terminate after ~10 seconds of idle and would kill both. Railway gives a paid always-on container at a flat ~₹500/month, which is exactly what we need.

Render's free tier sleeps after 15 minutes; their paid plan works too but is more expensive.

---

## 2. Pre-flight checklist (do these before opening Railway)

| ✅ | Item |
|---|---|
|   | Repo is pushed to GitHub on the `main` branch |
|   | `npm run build` works locally (no TS errors) |
|   | `.env.local` has all required keys filled in (used as a reference for what to copy into Railway) |
|   | MongoDB Atlas connection string is in hand and the IP allow-list is open (`0.0.0.0/0`) |
|   | `JWT_SECRET` matches the value in `server.me/.env` exactly |
|   | An Atlas Vector Search index named `listing_vector_index` exists on `listingproperties` (see Section 7) |

If you can tick all six, you're ready.

---

## 3. Create the Railway project

1. Go to [railway.app](https://railway.app) → **Sign in with GitHub**.
2. **New Project** → **Deploy from GitHub repo** → pick `majestic-escape-rag-ai-chat-widget`.
3. Railway auto-detects Next.js. It uses Nixpacks as the builder (already configured by [`railway.json`](railway.json)).
4. The first build will fail because env vars aren't set yet — that's expected. We'll fix it in the next section.

---

## 4. Configure environment variables

In the Railway dashboard, click your service → **Variables** tab → **Raw Editor**. Paste the block below, replacing every `<...>` with your real values:

```bash
# Required — the AI provider
GEMINI_API_KEY=<your-gemini-developer-api-key>

# Required — MongoDB Atlas
MONGODB_URI=<your-atlas-connection-string-incl-master-db>

# Required — must MATCH server.me/.env exactly
JWT_SECRET=<same-as-server.me-JWT_SECRET>

# Recommended — fallback AI providers (used when Gemini hits 429 quota)
GROQ_API_KEY=<your-groq-key>
XAI_API_KEY=<your-xai-key>

# Required — admin allow-list
# Comma-separated emails OR userIds. Anyone matching is treated as admin
# (since admin.site's current login flow doesn't stamp `admin: 1` in the JWT).
ADMIN_EMAILS=<comma-separated-admin-emails>
ADMIN_USER_IDS=<comma-separated-24-char-hex-ids>

# Required — CORS allow-list (Phase A: this MUST include every consumer site
# that loads the embed bundle, otherwise:
#   1. Cross-origin /api/chat fetch falls back to halved rate limits.
#   2. Socket.IO will reject WebSocket upgrades from unknown origins.
# Add www / staging / preview hostnames as needed.
ALLOWED_ORIGINS=https://majesticescape.in,https://www.majesticescape.in,https://admin.majesticescape.in

# Cost guardrails (24h caps; see ARCHITECTURE.md §8)
DAILY_AI_LIMIT_USER=200
DAILY_AI_LIMIT_IP=30

# Where the chat widget sends users when they click a property card
NEXT_PUBLIC_PROPERTY_BASE_URL=https://majesticescape.in

# Leave empty in prod — the widget defaults to its current origin
NEXT_PUBLIC_SUPPORT_SOCKET_URL=
```

### On the consumer site (e.g. `user.website`)

Phase A made `user.website` load the chat through a single script tag. Set this
on the consumer's deploy:

```env
# Absolute URL of the embed bundle. Without this, layout.tsx falls back to a
# dev-only inline loader that derives the URL from window.location.hostname.
NEXT_PUBLIC_CHAT_WIDGET_URL=https://chat.majesticescape.in/embed/widget.js
```

Also add `chat.majesticescape.in` to the consumer's CSP `script-src` directive
if a CSP is configured.

> **Do NOT set `PORT`.** Railway injects it automatically and the code reads `process.env.PORT`.

> **Do NOT set `NODE_ENV`.** Our `npm start` script (`cross-env NODE_ENV=production tsx server.ts`) sets it.

After saving, Railway will trigger a fresh build automatically.

---

## 5. Confirm Atlas allows Railway

Railway's egress IPs change. The simplest, safest setup is to leave Atlas open to `0.0.0.0/0` and rely on the strong connection-string auth (which is already in your URI).

If you must lock it down, use Atlas's **Private Endpoint** for VPC-peering — but that's only available on Atlas Dedicated tiers (M10+). For M0/M2/M5 the open IP allow-list is the standard pattern.

To verify: Atlas → **Network Access** → ensure either `0.0.0.0/0` is listed, or the specific Railway egress range is.

---

## 6. Verify the build succeeded

Railway → **Deployments** tab → click the latest deployment.

You should see, in order:

```
[boot] ready on http://localhost:<PORT>
[catchUpSync] processed N properties
[changeStream] watching listingproperties
```

If the boot logs show the first line and you can hit `/api/health` (next section), the Change Stream worker is running.

If the build itself fails, check the build logs for missing env vars or TS errors. Common fixes:

| Error | Fix |
|---|---|
| `JWT_SECRET not set` | Set it in Variables (see Section 4) |
| `MongoServerError: bad auth` | Connection string is wrong; copy a fresh one from Atlas |
| `MONGODB_URI not set` | Same as above |
| `Cannot find module '@google/genai'` | Stale cache — delete `.railway-cache` (rare) |
| TS build errors | Reproduce locally with `npm run build` |

---

## 7. Create the Atlas Vector Search index

This is a one-time Atlas dashboard task — Railway can't do it for you.

1. Atlas → **Database** → click your cluster → **Search** tab → **Create Search Index**.
2. Choose **Atlas Vector Search** (not the generic full-text search).
3. **Database**: `master-db` (or whatever's in your `MONGODB_URI`). **Collection**: `listingproperties`.
4. Index name: `listing_vector_index` (must match the name in [src/app/api/chat/route.ts](src/app/api/chat/route.ts)).
5. JSON definition:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 3072,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "status"
    }
  ]
}
```

6. Wait ~5 minutes for the index to build. Atlas shows progress in the Search tab.

> **`numDimensions` must be 3072** — that's the default output size of `gemini-embedding-001`. If you ever switch embedding models, both this index and the field need rebuilding.

> **Shortcut: run the included script.** [`scripts/createVectorIndex.js`](scripts/createVectorIndex.js) handles step 5 programmatically — it idempotently creates or updates the index using `MONGODB_URI` from `.env.local`:
> ```bash
> node scripts/createVectorIndex.js
> ```

> The first time you query the index, Atlas will return zero matches if no documents have an `embedding` field yet. The first run of `runCatchUpSync` populates them.

---

## 8. Healthcheck

Railway's `railway.json` already configures `/api/health` as the healthcheck path with a 30-second timeout. After the first successful deploy:

```bash
curl https://<your-service>.railway.app/api/health
# → {"ok":true,"db":true,"changeStream":{"isRunning":true,"lastEventTs":"..."},"timestamp":"..."}
```

`changeStream.isRunning: true` is the most important field. If it ever flips to `false`, Railway's auto-restart kicks in. You'll see it in **Deployments** → **Logs**.

---

## 9. Custom domain

Optional but recommended:

1. Railway → service → **Settings** → **Networking** → **Custom Domain**.
2. Add `chat-rag.majesticescape.in` (or whatever subdomain you choose).
3. Railway gives you a CNAME target. Add it to your DNS provider (Vercel DNS / Cloudflare / Namecheap).
4. Wait 5–60 min for DNS propagation. Railway provisions a TLS cert automatically.
5. Update **`NEXT_PUBLIC_SUPPORT_SOCKET_URL`** in your `user.website` deployment to point at this domain (otherwise widget connects to `window.location.origin`, which is `majesticescape.in` and will fail).

> If you skip the custom domain, Railway's default `<service>.up.railway.app` works too. Just plug it into `NEXT_PUBLIC_SUPPORT_SOCKET_URL` instead.

---

## 10. CORS — make sure browsers can connect

Railway terminates TLS and forwards the original `Origin` header. The service's CORS check uses `ALLOWED_ORIGINS`. If you see browser-side errors like:

```
Access to XMLHttpRequest at 'https://chat-rag.majesticescape.in/socket.io/...'
from origin 'https://majesticescape.in' has been blocked by CORS policy
```

Add the missing origin to `ALLOWED_ORIGINS` and redeploy.

The default value used in this guide already covers production:

```
ALLOWED_ORIGINS=https://majesticescape.in,https://admin.majesticescape.in
```

For localhost dev, also add `http://localhost:3000,http://localhost:3001`.

---

## 11. Smoke tests after deployment

Run these in order. If any fails, see the troubleshooting section below.

### Pre-flight: bundle reachability + CORS allow-list (do this first)

These four `curl`s exercise the bundle URL and the CORS allow-list directly. Run them right after changing any env var on Railway — they catch ~80% of misconfigurations before any user notices. Substitute origins/hosts for the environment you're verifying.

```bash
# 1. Staging — bundle reachable + CORS open for the bundle file itself
curl -sI -H "Origin: https://user.me.coderelix.in" https://chat.me.coderelix.in/embed/widget.js | grep -E "HTTP|access-control|content-type"
# Expected: HTTP/2 200, access-control-allow-origin: *, content-type: application/javascript

# 2. Staging — REST preflight from the user.website origin
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS \
  -H "Origin: https://user.me.coderelix.in" \
  -H "Access-Control-Request-Method: POST" \
  https://chat.me.coderelix.in/api/chat
# Expected: 204

# 3. Production — same two for the prod environment
curl -sI -H "Origin: https://majesticescape.in" https://chat.majesticescape.in/embed/widget.js | grep -E "HTTP|access-control|content-type"
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS \
  -H "Origin: https://majesticescape.in" \
  -H "Access-Control-Request-Method: POST" \
  https://chat.majesticescape.in/api/chat
# Expected: 200 + ACAO; 204 preflight

# 4. Negative test — a non-allow-listed origin SHOULD be rejected in prod
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS \
  -H "Origin: https://attacker.example.com" \
  -H "Access-Control-Request-Method: POST" \
  https://chat.majesticescape.in/api/chat
# Expected: 403 (or 204 with NO access-control-allow-origin header — browser will then block the response on the client side)
```

If any of (1)–(3) returns the wrong status or is missing the ACAO header, the `ALLOWED_ORIGINS` env on that Railway service is misconfigured. Fix it and re-run.

### A. Service is alive

```bash
curl https://<your-service>/api/health
```

Expect `{"ok":true,"db":true,...}`.

### B. AI chat works

```bash
curl -N -X POST https://<your-service>/api/chat \
  -H "Content-Type: application/json" \
  -H "Origin: https://majesticescape.in" \
  -d '{"message":"villas in goa under 5000","history":[]}'
```

Expect a streaming SSE response with `data: <chunk>\n\n` lines and a final `data: [DONE]`.

### C. Embeddings are populated

```bash
# First, run catch-up sync to populate any missing embeddings
curl -X POST https://<your-service>/api/admin/embed-all \
  -H "Authorization: Bearer <your-admin-jwt>"
# Expect: {"ok":true,"processed":N}
```

### D. Support socket accepts connections

Open a browser at `https://majesticescape.in`, open the chat widget, click the **Support** tab. The widget should show "Connected" within 1–2 seconds. The browser DevTools → Network tab should show a successful WebSocket upgrade to `wss://<your-service>/socket.io/?EIO=4`.

### E. Admin can reply

1. Log into `admin.majesticescape.in` as a user listed in `ADMIN_EMAILS` or `ADMIN_USER_IDS`.
2. Navigate to `/dashboard/support-chat`.
3. The conversation from step D should appear in the list.
4. Click it, type a reply → it should reach the user widget within 1 second.

If all five pass, you're live.

---

## 12. Auto-deploy and CI/CD

By default, Railway redeploys on every push to `main`. To gate this:

- Settings → **Service** → **Source** → toggle "Auto Deploy" off if you want manual deploys only.
- Or set up a `staging` branch with its own Railway service for pre-prod testing, and only merge to `main` after testing there.

---

## 13. Logs, metrics, and observability

Railway provides:

- **Live logs**: Deployments → click any deployment → Logs.
- **Metrics**: Service → **Metrics** tab — CPU, memory, network. Set an alarm if memory creeps above 400MB (default container is 512MB).
- **Restarts**: Service → **Deployments** — every restart shows here with the trigger reason (crash / manual / config change).

For deeper monitoring (paging on failures, custom dashboards), wire `/api/health` into UptimeRobot or BetterUptime — both have free tiers.

---

## 14. Updating env vars without redeploy

Railway DOES restart the container when you change a variable. There's no way to update env without a brief downtime. To minimise impact:

- Make changes during low-traffic windows (the support chat reconnects automatically; AI chat retries on next user input).
- Or use Railway's "Deployment Triggers" → manual deploys, and group multiple env changes into a single restart.

---

## 15. Scaling considerations

This service is single-instance by default. That's fine until you reach roughly:

- 1000 concurrent support chats, OR
- 10000 AI chat requests per hour, OR
- 50 conversation creations per second

When you hit any of these, you'll need to:

1. **Move the rate-limiter from in-memory to Redis** (`src/lib/rateLimit.ts`) so multiple instances share buckets.
2. **Add a Redis Socket.IO adapter** (`@socket.io/redis-adapter`) so messages broadcast across all instances.
3. **Add a second instance** in Railway → service → **Settings** → **Replicas** → 2.

Until then, **stay single-instance**. It's cheaper and simpler.

---

## 16. Troubleshooting

### "Service is up but `/api/chat` returns 500"

Check logs for:

- `JWT_SECRET not set` — set it.
- `MongoServerError` — connection string wrong or Atlas IP allow-list closed.
- `embedding query failed: 429` — Gemini quota exhausted. Add `GROQ_API_KEY` for fallback.

### "Support tab shows 'Connecting…' forever"

- Browser DevTools → Network → check the WebSocket request. If it's 1006/aborted, CORS or domain misconfig.
- Verify `NEXT_PUBLIC_SUPPORT_SOCKET_URL` in `user.website` matches the public Railway URL.
- Verify `ALLOWED_ORIGINS` on Railway includes your site origin.

### "Properties show but never refresh after I edit them"

- Change Stream worker is dead. Hit `/api/health` — `isRunning` should be `true`.
- If `false`, check logs for "ChangeStream history lost" → run `runCatchUpSync` manually:
  ```bash
  curl -X POST https://<your-service>/api/admin/embed-all -H "Authorization: Bearer <jwt>"
  ```

### "Build fails with `Cannot find module '@types/...'`"

You're missing a dev dep. Run `npm install` locally, commit `package-lock.json`, push.

### "Railway shows the deploy as 'Crashed'"

Click the deployment → Logs. The crash reason is always at the very end. Common ones:

| Last line | Fix |
|---|---|
| `MONGODB_URI is not set` | Set the env var |
| `Error: listen EADDRINUSE` | Port collision — Railway provides PORT; don't override it |
| `OOMKilled` | Memory exceeded 512MB. Upgrade plan or fix a leak |

---

## 17. Rollback

Railway → **Deployments** → click any successful past deployment → **Redeploy**.

Or, in Git: `git revert <bad-commit>` → `git push origin main`. Railway picks it up.

---

## 18. Cost ballpark

At launch volumes (a few thousand monthly active users, ~10 concurrent support chats):

| Item | Monthly |
|---|---|
| Railway (Pro plan, 512MB / 1 vCPU, always-on) | ~₹500 |
| MongoDB Atlas M0 (free tier) | ₹0 |
| Gemini Developer API (free tier: 15 req/min, 1M tokens/day) | ₹0 |
| Groq + xAI fallbacks | Pay-as-you-go (negligible if Gemini covers most) |

Total: ~₹500/month at launch.

If Gemini's free tier becomes insufficient: upgrade to a paid Gemini key, or budget ~$5/month for Groq pay-as-you-go (which has a generous free tier of its own).

---

## 19. Going to multi-region / HA later

When traffic grows enough to need it, the path is:

1. Move MongoDB to a paid Atlas M10+ in the same region(s) as Railway.
2. Add Redis (Upstash on Railway works fine) for shared state.
3. Configure Socket.IO `redisAdapter` (one import in `server.ts` plus an env var).
4. Bump Railway replicas to 2+.

Single-instance + free Atlas is fine for the first 12+ months.

---

## 20. Quick reference card

```
Service URL:     https://chat-rag.majesticescape.in
Health endpoint: /api/health
Admin token:     localStorage.token from admin.majesticescape.in
Logs:            railway dashboard → Deployments → Logs
Restart:         railway dashboard → service → restart
Re-embed all:    POST /api/admin/embed-all (admin JWT)
Re-embed one:    POST /api/admin/embed/<id> (admin JWT)
Delete convo:    DELETE /api/admin/conversations/<id> (admin JWT)
Export convo:    GET /api/support/conversations/<id>/transcript[?format=json]
```

You're done. Welcome to production.
