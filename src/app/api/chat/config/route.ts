// Public widget configuration.
//
// The embed bundle calls this when the panel opens to decide whether to render
// the AI tab. It is deliberately mounted under /api/chat/* so the existing CORS
// matcher in src/middleware.ts (`/api/chat/:path*`) covers it — the widget runs
// cross-origin on majesticescape.in, so without that it would be blocked.
//
// This endpoint is advisory only. It shapes the UI; it does not authorise
// anything. /api/chat and /api/chat/history each re-check the flag server-side,
// so a caller who fakes or ignores this response still cannot get an AI reply.
//
// No auth: it leaks nothing beyond "is the assistant currently offered", which
// is visible to anyone who opens the widget anyway.

import { NextResponse } from "next/server";
import { isAiEnabled } from "@/lib/aiToggle";
import { getFeatureFlags } from "@/lib/featureToggles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // supportEnabled / messagingEnabled are additive: an older widget bundle or
  // site that only reads `aiEnabled` keeps working. user.website reads
  // `messagingEnabled` from here too, so its pages and the chat service agree.
  const [aiEnabled, flags] = await Promise.all([isAiEnabled(), getFeatureFlags()]);
  return NextResponse.json(
    { aiEnabled, supportEnabled: flags.support, messagingEnabled: flags.messaging },
    // no-store so an ops flip reaches open browsers within the module's own
    // cache TTL rather than sitting behind a CDN/browser cache.
    { headers: { "Cache-Control": "no-store" } }
  );
}
