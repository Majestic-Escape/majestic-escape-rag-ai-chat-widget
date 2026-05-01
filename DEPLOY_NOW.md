# Deploy now — 1-page action checklist

This is the **simplest possible** path from "I have a Railway project created" → "chat is live on the dev domain" → "chat is live on production." Follow it top-to-bottom. Each step links into [`RAILWAY_DEPLOYMENT.md`](RAILWAY_DEPLOYMENT.md) when you want depth.

> **You are here:** Railway project `majestic-rag-chatbot-server` is created. The first build failed at the security scan because `next@15.3.1` had CVEs. Step 1 fixes that.

---

## § 0. Pre-flight (one-time per cluster)

These are independent of Railway. Do them in any order.

| ✅ | Item | How |
|---|---|---|
| ☐ | Atlas cluster reachable | M0 free tier is fine for current scale (~12 active properties). Any tier above M0 also works. The chatbot shares the cluster with `server.me`. |
| ☐ | Network Access has `0.0.0.0/0` | Atlas → **Network Access** → confirm `0.0.0.0/0` is **Active** (Railway's egress IPs rotate, so a static allow-list won't work). |
| ☐ | Vector index `listing_vector_index` ready | Two paths, pick one: (a) **CLI** — `npm run atlas:create-index` locally with `MONGODB_URI=<prod>` exported. (b) **Atlas UI** — Search & Vector Search → **+ Create Search Index** → **Vector Search** → JSON Editor → name `listing_vector_index` on `master-db.listingproperties` with `{"fields":[{"type":"vector","path":"embedding","numDimensions":3072,"similarity":"cosine"}]}`. Wait for status `READY`. Both paths are idempotent. |
| ☐ | At least one admin in DB | Atlas → Data Explorer → `master-db.admins` → confirm one document with `role:"admin"` and not banned. New admins are auto-created via `admin.site`'s signup flow — no manual step. |
| ☐ | `JWT_SECRET` matches `server.me/.env` | Same exact string in both `server.me` and the chatbot's Railway env. Otherwise admin JWTs from `admin.site` won't verify on the chatbot. |

> **Note on the "Documents Indexed" metric in Atlas Search**: it counts the entire collection, not docs that actually have embeddings. To see how many properties are *actually* embedded, run this in Data Explorer's `listingproperties` query bar: `{ embedding: { $exists: true } }`. After first Railway boot, that count should equal `{ status: "active" }` count — the chatbot embeds only active properties.

---

## § 1. Fix the Next.js CVE (the build blocker)

Already done in this commit:
- `package.json`: `"next": "^15.3.8"` (resolves to 15.5.15 today, satisfies all CVE patches)
- `package-lock.json`: refreshed via `npm install`
- `src/embed/vite-env.d.ts`: declares `*.css?inline` so the stricter type-check in Next 15.5 passes

Verify locally before pushing if you ever bump again:

```bash
npm install
npm run build           # vite embed bundle + next build
```

Both must succeed. Then `git push` — Railway auto-redeploys and the security scan passes.

---

## § 2. Railway: connect repo

Inside `majestic-rag-chatbot-server`:

1. **+ New** → **GitHub Repo** → pick `majestic-escape-rag-ai-chat-widget` → branch `main`.
2. Railway auto-detects Next.js via Nixpacks; [`railway.json`](railway.json) provides start command + `/api/health` healthcheck.
3. The first build will fail until env vars are set (next step).

---

## § 3. Railway: env vars (development domain)

Service → **Variables** → **Raw Editor** → paste this block, replacing `<…>`:

```bash
# Required
GEMINI_API_KEY=<gemini-developer-api-key>
MONGODB_URI=<atlas-connection-string>
JWT_SECRET=<exact-same-as-server.me-.env>

# Recommended (fallbacks when Gemini hits 429 / rate limit)
GROQ_API_KEY=<groq-key>
XAI_API_KEY=<xai-key>

# Admin allow-list — LEAVE BLANK in production.
# The chatbot looks up admin status from the `admins` collection (populated by
# admin.site's signup flow). Adding a new admin = creating their Admin record;
# no env-var update needed. These vars stay as emergency overrides only.
ADMIN_EMAILS=
ADMIN_USER_IDS=

# CORS — DEV/STAGING DOMAINS
ALLOWED_ORIGINS=https://user.me.coderelix.in,https://admin.me.coderelix.in

# Where the chat sends users when they click a property card
NEXT_PUBLIC_PROPERTY_BASE_URL=https://user.me.coderelix.in

# Cost guardrails
DAILY_AI_LIMIT_USER=200
DAILY_AI_LIMIT_IP=30
```

**Do NOT set `PORT`** — Railway injects it.
**Do NOT set `NODE_ENV`** — `npm start` does that via `cross-env`.

Save → Railway redeploys automatically.

---

## § 4. Railway: custom domain (dev)

Service → **Settings** → **Networking** → **Custom Domain** → add `chat.me.coderelix.in`.

Railway gives you a CNAME target. Add it at your DNS provider (Cloudflare / Namecheap / Vercel DNS). Wait 5–60 min — Railway provisions a TLS cert automatically.

Until DNS is live, Railway's default `<service>.up.railway.app` URL works fine for testing.

---

## § 5. Railway: CI/CD

**Auto-deploy is on by default** — every push to `main` triggers a fresh build.

| Need | Where |
|---|---|
| Disable auto-deploy | Settings → **Source** → toggle "Auto Deploy" off |
| Wait for GitHub Actions before deploy | Settings → **Source** → "Wait for CI" → on |
| Manual deploys | Settings → **Deploys** → "Trigger Deploy" |
| Scripted deploys (e.g. from another CI) | Settings → **Tokens** → create a Deploy Token, then `curl` Railway's GraphQL with it |

**Recommended branch strategy** (when ready for prod):
- `main` → **prod** Railway service (a separate service in the same project)
- `staging` (or just keep using `main` until you're ready to split) → **dev** Railway service (this one)

Per [`RAILWAY_DEPLOYMENT.md § 0`](RAILWAY_DEPLOYMENT.md#0-production--staging-checklist-read-this-first), the recommended pattern is **two services** so a bad bundle on dev can't bleed into prod and the data stays isolated.

---

## § 6. Vercel: `user.website` env var

This is what makes the chat widget appear on the consumer site.

Vercel → user.website project → **Settings** → **Environment Variables** → add:

| Var | Value | Environments |
|---|---|---|
| `NEXT_PUBLIC_CHAT_WIDGET_URL` | `https://chat.me.coderelix.in/embed/widget.js` | Preview + Production |

Then trigger a redeploy (Deployments → … → Redeploy). Without this var, the dev-loader in [`src/app/layout.tsx`](https://github.com/Majestic-Escape/user.website/blob/shriraj-dev/src/app/layout.tsx) refuses to run on a public hostname and prints a clear `console.error` pointing at this exact var — designed to make the misconfig visible in DevTools.

---

## § 7. Vercel: `admin.site` env var

Powers the admin Support Chat panel's Socket.IO connection.

Vercel → admin.site project → **Settings** → **Environment Variables** → add:

| Var | Value | Environments |
|---|---|---|
| `NEXT_PUBLIC_SUPPORT_SOCKET_URL` | `https://chat.me.coderelix.in` | Preview + Production |

Redeploy.

---

## § 8. Smoke tests (run after each env-var change)

These four `curl`s catch ~80% of misconfigurations before any user notices.

```bash
# 1. Bundle reachable + CORS open
curl -sI -H "Origin: https://user.me.coderelix.in" \
  https://chat.me.coderelix.in/embed/widget.js \
  | grep -E "HTTP|access-control|content-type"
# Expect: HTTP/2 200, access-control-allow-origin: *, content-type: application/javascript

# 2. REST preflight from user.website origin
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS \
  -H "Origin: https://user.me.coderelix.in" \
  -H "Access-Control-Request-Method: POST" \
  https://chat.me.coderelix.in/api/chat
# Expect: 204

# 3. Negative test — non-allow-listed origin must be rejected
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS \
  -H "Origin: https://attacker.example.com" \
  -H "Access-Control-Request-Method: POST" \
  https://chat.me.coderelix.in/api/chat
# Expect: 403 (or 204 with NO access-control-allow-origin header)

# 4. Service health
curl https://chat.me.coderelix.in/api/health
# Expect: {"ok":true,"db":true,"changeStream":{"isRunning":true,...}}
```

**UI smoke** (the actual product test):
1. Open `https://user.me.coderelix.in/stays` → chat launcher visible bottom-right.
2. Open the panel → send "villas in goa" → property cards stream in.
3. Switch to **Support** tab → status pill shows "Connected" within 1–2 s.
4. Log into `https://admin.me.coderelix.in` → `/dashboard/support-chat` → conversation appears in list → reply → reaches user widget within 1 s.

---

## § 9. Promote to production

**Order matters here.** Don't change DNS until the new Railway service is built and ready, or the chatbot domain will be unreachable during the gap.

### 9a. Create the production Railway service

In the same `majestic-rag-chatbot-server` project: **+ New** → **GitHub Repo** → pick the chat widget repo, branch `main`. Set production env vars:

| Var | Prod value |
|---|---|
| `MONGODB_URI` | **prod** Atlas DB (NOT dev) |
| `JWT_SECRET` | **prod** server.me secret (NOT dev) — must match exactly |
| `GEMINI_API_KEY` | prod or shared key |
| `GROQ_API_KEY` / `XAI_API_KEY` | prod or shared keys |
| `ALLOWED_ORIGINS` | `https://majesticescape.in,https://www.majesticescape.in,https://admin.majesticescape.in` |
| `NEXT_PUBLIC_PROPERTY_BASE_URL` | `https://majesticescape.in` |
| `DAILY_AI_LIMIT_USER` / `DAILY_AI_LIMIT_IP` | `200` / `30` |
| `ADMIN_EMAILS` / `ADMIN_USER_IDS` | **leave blank** — DB-backed admin lookup handles this |

Wait for the build to go Active. Verify with `curl https://<new-service>.up.railway.app/api/health` → `db:true, changeStream.isRunning:true`.

### 9b. Remove the existing `chat.majesticescape.in` redirect

If `chat.majesticescape.in` is currently set up to redirect to `majesticescape.in` at the DNS / hosting layer (Cloudflare page rule, Vercel domain redirect, etc.), **remove that redirect now**. It will break the chatbot bundle, API, and Socket.IO upgrades the moment Railway takes over the subdomain. (The chatbot's own `next.config.ts` redirect handles browser navigation to `/` — see § 10 below for what stays clickable.)

### 9c. Point DNS at Railway

Railway → prod service → **Settings** → **Networking** → **Custom Domain** → add `chat.majesticescape.in`. Railway gives you a CNAME target. Update DNS, wait 5–60 min for propagation. Railway provisions a TLS cert automatically.

### 9d. Switch consumer Vercel sites to the prod URL

| Site | Var | Prod value | Vercel env |
|---|---|---|---|
| `user.website` | `NEXT_PUBLIC_CHAT_WIDGET_URL` | `https://chat.majesticescape.in/embed/widget.js` | Production |
| `admin.site` | `NEXT_PUBLIC_SUPPORT_SOCKET_URL` | `https://chat.majesticescape.in` | Production |

Redeploy each Vercel site. Then re-run the § 8 smoke curls against `chat.majesticescape.in`.

### 9e. What still works at chat.majesticescape.in/

Browser navigation to `https://chat.majesticescape.in/` returns a 307 redirect to `https://majesticescape.in/` (configured in the chatbot's `next.config.ts`, ships with the code). So you do NOT need a DNS-layer redirect — the app itself handles the "no broken pages" UX. Bundle, API, and Socket.IO paths are NOT affected by this redirect.

---

## § 10. Rollback / observability

| Need | Where |
|---|---|
| Roll back a bad deploy | Railway → **Deployments** → click any past green build → **Redeploy** |
| Live logs | Service → **Deployments** → click latest → **Logs** tab |
| Health | `curl https://chat.me.coderelix.in/api/health` — `changeStream.isRunning: true` is the load-bearing field |
| Re-run catch-up sync (re-embeds stale properties) | `POST /api/admin/embed-all` with admin JWT |
| Restart container | Service → **Settings** → **Restart** |

---

## § 11. When stuck

1. [`RAILWAY_DEPLOYMENT.md § 16 Troubleshooting`](RAILWAY_DEPLOYMENT.md#16-troubleshooting) — the canonical troubleshooting matrix.
2. [`docs/PROD_AUDIT.md`](docs/PROD_AUDIT.md) — production-readiness audit, mandatory env vars and why.
3. Check `/api/health`. If `db: false`, Atlas auth or IP allow-list is wrong. If `changeStream.isRunning: false`, the worker died — Railway will auto-restart, but check logs for the cause.

---

## Appendix: "What if Railway build fails again?"

| Build log says… | Fix | Reference |
|---|---|---|
| `SECURITY VULNERABILITIES DETECTED — next@…` | Bump next, refresh lockfile, push (same as § 1). | This file § 1 |
| `JWT_SECRET not set` / `MONGODB_URI not set` | Add to Variables. | § 3 |
| `MongoServerError: bad auth` | Connection string is wrong — copy fresh from Atlas. Watch out for `<password>` placeholders. | [`RAILWAY_DEPLOYMENT.md § 6`](RAILWAY_DEPLOYMENT.md#6-verify-the-build-succeeded) |
| `MongoServerError: connection refused` / timeout | Atlas Network Access — `0.0.0.0/0` not in allow-list. | § 0 |
| `OOMKilled` | Container hit 512 MB. Either upgrade Railway plan or check for a memory leak in worker code. | [`RAILWAY_DEPLOYMENT.md § 16`](RAILWAY_DEPLOYMENT.md#16-troubleshooting) |
| `Cannot find module '@types/…'` | Dev dep missing — run `npm install` locally, commit `package-lock.json`, push. | — |
