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

import { NextResponse, type NextRequest } from "next/server";
import { isAiEnabled } from "@/lib/aiToggle";
import { getFeatureFlags } from "@/lib/featureToggles";
import { aiDraftEnabled, canaryPercent, chatIdentity, pilotLive, pipelineMode, searchMode } from "@/lib/rag/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // supportEnabled / messagingEnabled are additive: an older widget bundle or
  // site that only reads `aiEnabled` keeps working. user.website reads
  // `messagingEnabled` from here too, so its pages and the chat service agree.
  const [aiEnabled, flags] = await Promise.all([isAiEnabled(), getFeatureFlags()]);
  // Additive: the widget offers its filter buttons from the first screen when the filters pilot is live.
  // Only for a visitor the pilot answers (the canary), decided as /api/chat decides it. A caller that sends no
  // identity (a bundle older than this check) gets the controls only while the canary is everyone.
  const guest = req.nextUrl.searchParams.get("guestSessionId");
  const identified = guest !== null || req.headers.has("authorization");
  const live = identified ? pilotLive(chatIdentity(req.headers, guest)) : pipelineMode() === "v2" && canaryPercent() >= 100;
  const searchControls = live && searchMode() === "filters";
  return NextResponse.json(
    { aiEnabled, supportEnabled: flags.support, messagingEnabled: flags.messaging, searchControls, aiDraft: searchControls && aiDraftEnabled() },
    // no-store so an ops flip reaches open browsers within the module's own
    // cache TTL rather than sitting behind a CDN/browser cache.
    { headers: { "Cache-Control": "no-store" } }
  );
}
