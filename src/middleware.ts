// Cross-origin support for the chat REST API.
//
// The widget bundle is loaded onto user.website and other approved sites and
// fetches /api/chat + /api/chat/history directly across origins. We need:
//   1. OPTIONS preflights answered with 204 + the right Access-Control-* headers.
//   2. Actual responses tagged with Access-Control-Allow-Origin so the browser
//      hands them to JS.
//
// The route handlers themselves enforce additional rate-limit / origin policies
// (src/app/api/chat/route.ts uses the ALLOWED_ORIGINS env var to decide whether
// a cross-origin caller gets the full or halved rate-limit allotment). This
// middleware only opens the network door — the API still polices what flows
// through it.

import { NextRequest, NextResponse } from "next/server";

const ALLOW_HEADERS = "Authorization, Content-Type, X-Forwarded-For";
const ALLOW_METHODS = "GET, POST, OPTIONS";

// Returns the allow-origin value to echo back, or null if the request origin
// is not authorised (in which case the header is omitted — browser blocks).
//
// Dev (NODE_ENV !== production): echo any origin. Local LAN access from a
//   phone via http://192.168.x.x:3000 is a normal dev case, and ALLOWED_ORIGINS
//   would otherwise need to enumerate every dev's machine IP.
// Prod: strict allow-list. Unknown origin → no header → browser blocks the
//   response. We deliberately do NOT fall back to list[0] because that would
//   send a wrong-but-valid value and is silently misleading.
function allowedOrigin(req: NextRequest): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return "*"; // same-origin / non-CORS requests

  if (process.env.NODE_ENV !== "production") return origin;

  const list = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return origin; // unset → permissive (matches socket.io fallback)
  return list.includes(origin) ? origin : null;
}

export function middleware(req: NextRequest) {
  const origin = allowedOrigin(req);
  const baseHeaders: Record<string, string> = { Vary: "Origin" };
  if (origin) {
    baseHeaders["Access-Control-Allow-Origin"] = origin;
  }

  if (req.method === "OPTIONS") {
    return new NextResponse(null, {
      status: origin ? 204 : 403,
      headers: origin
        ? {
            ...baseHeaders,
            "Access-Control-Allow-Methods": ALLOW_METHODS,
            "Access-Control-Allow-Headers": ALLOW_HEADERS,
            "Access-Control-Max-Age": "86400",
          }
        : baseHeaders,
    });
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(baseHeaders)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: ["/api/chat/:path*", "/api/chat"],
};
