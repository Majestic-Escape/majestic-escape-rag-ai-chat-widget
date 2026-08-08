// Admin control for the AI chatbot kill-switch.
//
// GET  → { aiEnabled }            current state, for the admin.site toggle UI
// POST → { enabled: boolean }     flip it
//
// Admin-only via the same DB-backed `resolveIsAdmin` guard used by the other
// admin routes (see api/admin/embed-all/route.ts). The public read for the
// widget lives at /api/chat/config — this route is not for the widget.

import { NextRequest, NextResponse } from "next/server";
import { verifyToken, resolveIsAdmin } from "@/lib/jwt";
import { isAiEnabled, setAiEnabled } from "@/lib/aiToggle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

function userIdOf(payload: { userId?: string; id?: string } | null): string | null {
  if (!payload) return null;
  if (typeof payload.userId === "string") return payload.userId.trim() || null;
  if (typeof payload.id === "string") return payload.id.trim() || null;
  return null;
}

export async function GET(req: NextRequest) {
  const payload = verifyToken(bearer(req));
  if (!(await resolveIsAdmin(payload))) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }
  return NextResponse.json(
    { aiEnabled: await isAiEnabled() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  const payload = verifyToken(bearer(req));
  if (!(await resolveIsAdmin(payload))) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    // Strict: no truthy-string coercion. A typo must not silently re-enable
    // spending.
    return NextResponse.json(
      { error: "body.enabled must be a boolean" },
      { status: 400 }
    );
  }

  await setAiEnabled(enabled, userIdOf(payload));
  console.log(
    `[ai-toggle] AI chatbot ${enabled ? "ENABLED" : "DISABLED"} by ${
      userIdOf(payload) ?? "unknown admin"
    }`
  );

  return NextResponse.json(
    { aiEnabled: enabled },
    { headers: { "Cache-Control": "no-store" } }
  );
}
