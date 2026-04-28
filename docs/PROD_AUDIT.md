# Production Readiness Audit — chatbot widget service

This document records the findings of the **2026-04-28 production readiness audit** of `majestic-escape-rag-ai-chat-widget` and the safety nets that were added as a result. Future operators (and AI assistants) should read this before any first-time deploy of the chatbot to a new environment.

> Living document. Update it whenever a new origin is added or a new env var becomes load-bearing.

## TL;DR

Ports cannot cause production failure — every service runs in its own container with its own host-assigned port. **What CAN fail in production is a misconfigured environment variable.** The four mandatory environment variables are:

1. `NEXT_PUBLIC_CHAT_WIDGET_URL` on the consumer (user.website) — without it, the dev fallback fires on the public domain and the chat silently fails to load.
2. `ALLOWED_ORIGINS` on the widget service — without it, every origin is allowed (less safe); with it, only listed origins work.
3. `JWT_SECRET` on the widget service — must match `server.me`'s value byte-for-byte, or logged-in users appear anonymous.
4. `NEXT_PUBLIC_SUPPORT_SOCKET_URL` on the admin console — without it, admins can't connect to the support socket.

See [`RAILWAY_DEPLOYMENT.md § 0`](../RAILWAY_DEPLOYMENT.md) for the full per-environment matrix.

## Environments the chatbot must support

| Environment | user.website origin | admin.site origin | Recommended widget URL |
|---|---|---|---|
| **Staging / dev** | `https://user.me.coderelix.in` | `https://admin.me.coderelix.in` | `https://chat.me.coderelix.in/embed/widget.js` |
| **Production** | `https://majesticescape.in` (+ `www.`) | `https://admin.majesticescape.in` | `https://chat.majesticescape.in/embed/widget.js` |

**Architectural recommendation**: deploy two separate widget services (one Railway instance per environment). The cost is small (~$5/mo extra) and the operational safety is large — staging breakage doesn't bleed into prod, and you can verify a bundle on staging before promoting to prod.

If forced to share a single widget service, list all four origins in `ALLOWED_ORIGINS`. Documented as Pattern A in `RAILWAY_DEPLOYMENT.md`.

## What the audit looked at

### 1. Hard-coded URL grep across the chatbot codebase

Grepped for `localhost`, `127.0.0.1`, `192.168`, and `:3003` in:

- `majestic-escape-rag-ai-chat-widget/src/**`
- `majestic-escape-rag-ai-chat-widget/server.ts`
- `majestic-escape-rag-ai-chat-widget/next.config.ts`
- `majestic-escape-rag-ai-chat-widget/vite.embed.config.ts`
- `user.website/src/**`

**Result**: only matches were inside `// comments` (e.g. `// localhost). Fall back to crypto.getRandomValues — available everywhere`) and **one real risk** in `user.website/src/app/layout.tsx`'s `DEV_LOADER` fallback. Fixed in 2026-04-28 — see § Mitigations.

### 2. Bundle's runtime URL derivation

[`src/embed/utils.ts → getBackendUrl()`](../src/embed/utils.ts) priority chain:

1. `window.MAJESTIC_CHAT_BACKEND` — page override (rarely used)
2. `import.meta.env.VITE_BACKEND_URL` — build-time injection (intentionally unset)
3. **Origin of the loading `<script src>`** — auto-derived; this is the prod path
4. `window.location.origin` — final fallback

When the bundle is loaded from `https://chat.majesticescape.in/embed/widget.js`, derivation #3 returns `https://chat.majesticescape.in` — same origin as the widget service. **No backend-URL env var needed on the consumer side**, by design.

### 3. CORS / origin allow-list semantics

[`src/middleware.ts → allowedOrigin()`](../src/middleware.ts) — the actual prod-vs-dev policy:

| Condition | Behaviour |
|---|---|
| No `Origin` header | Returns `*` (same-origin or non-CORS request) |
| `NODE_ENV !== "production"` | Echoes any origin (dev / LAN-IP / coderelix testing all just work without env) |
| `ALLOWED_ORIGINS` env unset (in prod) | Echoes any origin — permissive default |
| `ALLOWED_ORIGINS` env set (in prod) | Returns the request origin only if it's in the list, else **`null`** → middleware omits the header → browser blocks the response |

[`server.ts → corsOriginCheck`](../server.ts) mirrors the same logic for Socket.IO.

**Implication**: setting `ALLOWED_ORIGINS` correctly is the difference between *"secure but may fail silently if list is incomplete"* and *"open by default but always works."* Pick correct over open.

### 4. Mongoose 7 + Atlas SRV DNS

`server.me` uses Mongoose 7 which calls Node's `dns.resolveTxt` to look up Atlas TXT records for the `mongodb+srv://` URI. Some local DNS servers refuse these queries (`EREFUSED`). The widget service uses the modern `mongodb@^6` driver which is more resilient.

**Permanent fix** (already applied locally): converted `server.me/.env` to use the direct `mongodb://host1,host2,host3` form, bypassing SRV lookup. Production deployments on Railway / Vercel / Render don't hit this issue (their resolvers are reliable), but the direct form remains as a backup option if it ever does.

## Mitigations applied 2026-04-28

### M1 — Loud failure for missing `NEXT_PUBLIC_CHAT_WIDGET_URL`

[`user.website/src/app/layout.tsx`](../../user.website/src/app/layout.tsx) — the `DEV_LOADER` now refuses to run on a non-local hostname (i.e. anything that isn't `localhost`, `127.0.0.1`, or RFC-1918 private). When the env var is missing on a public deployment, the inline script writes a clear `console.error` pointing at the exact env var to set:

```
[Majestic Chat] NEXT_PUBLIC_CHAT_WIDGET_URL is not set. The chat widget will not load on this domain. Set NEXT_PUBLIC_CHAT_WIDGET_URL to your widget service URL (e.g. https://chat.majesticescape.in/embed/widget.js) on the deployment platform of this site (Vercel → Settings → Variables) and redeploy.
```

So future first-time deploys will get a one-glance diagnostic in DevTools instead of a silent missing widget.

### M2 — Production + Staging checklist at top of `RAILWAY_DEPLOYMENT.md`

[`RAILWAY_DEPLOYMENT.md § 0`](../RAILWAY_DEPLOYMENT.md) now opens with the full per-environment env-var matrix (staging + prod, all four origins). Operators see it before any other content.

### M3 — Smoke-check curls in `RAILWAY_DEPLOYMENT.md § 11`

Four `curl` commands the operator runs immediately after changing any env var:

1. Staging bundle reachability + ACAO header.
2. Staging `/api/chat` preflight from the staging user.website origin.
3. Same two for prod.
4. **Negative test**: an unlisted origin must be rejected in prod (verifies the allow-list is actually enforced).

These catch ~80% of CORS/env misconfigurations before any user notices.

## Out-of-scope / future work

These are observed but deferred — none are prod-blocking:

- **Auto-failover between widget service replicas** — single Railway instance is fine for current scale.
- **CDN-fronting the bundle** — current `Cache-Control: max-age=300, swr=86400` is sufficient.
- **`NEXT_PUBLIC_SUPPORT_SOCKET_URL` cleanup in `user.website/.env.local`** — stale post-Phase-A but harmless; not worth a PR.
- **`majestic-chat` port mismatch (code defaults 3001, doc says 3002)** — pre-existing in that separate repo; not the chatbot's problem.

## When this audit needs to be re-run

Trigger a fresh audit if any of these happen:

- A new staging or prod origin is added (new branded domain, white-label deployment, etc.)
- `server.me` rotates `JWT_SECRET`
- Atlas cluster is migrated (URI format changes)
- `Next.js` major version bump (might change `next/script` behaviour or the Vercel runtime port assignment)
- Anyone else in the team adds an env var that gets baked into the bundle at build time

## See also

- [`RAILWAY_DEPLOYMENT.md`](../RAILWAY_DEPLOYMENT.md) — complete deployment guide
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — what the service does and how it's wired
- [`CLAUDE.md`](../CLAUDE.md) — Claude Code conventions for this repo
- [`README.md`](../README.md) — top-level overview + integration snippet
