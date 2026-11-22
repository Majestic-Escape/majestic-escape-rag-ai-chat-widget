// Admin control for the Support-chat and guest↔host-messaging switches.
//
// GET  → { supportEnabled, messagingEnabled }
// POST → { feature: "support" | "messaging", enabled: boolean }
//
// Same admin-only DB-backed guard as ai-toggle/route.ts. The AI switch keeps its
// own route (its fail-closed contract is different); the public read for the
// widget and the site lives at /api/chat/config.

import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import clientPromise, { appDbName } from "@/lib/mongodb";
import { verifyToken, resolveIsAdmin } from "@/lib/jwt";
import { adminStanding } from "@/lib/supportNames";
import { FEATURE_IDS, FeatureId, getFeatureFlags, setFeatureEnabled } from "@/lib/featureToggles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

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
  if (!(await resolveIsAdmin(verifyToken(bearer(req))))) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }
  const flags = await getFeatureFlags();
  return NextResponse.json(
    { supportEnabled: flags.support, messagingEnabled: flags.messaging },
    { headers: NO_STORE }
  );
}

export async function POST(req: NextRequest) {
  const payload = verifyToken(bearer(req));
  if (!(await resolveIsAdmin(payload))) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }
  // A token outlives a deactivation; the admin's record decides (same check as
  // the other admin routes that change customer-facing state).
  const adminId = userIdOf(payload);
  if (adminId && /^[0-9a-fA-F]{24}$/.test(adminId)) {
    const db = (await clientPromise).db(appDbName());
    const standing = await adminStanding(db, new ObjectId(adminId));
    if (standing.known && !standing.allowed) {
      return NextResponse.json({ error: "admin only" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { feature, enabled } = (body ?? {}) as { feature?: unknown; enabled?: unknown };
  if (typeof feature !== "string" || !FEATURE_IDS.includes(feature as FeatureId)) {
    return NextResponse.json({ error: "body.feature must be 'support' or 'messaging'" }, { status: 400 });
  }
  // Strict, no truthy-string coercion: a typo must not silently flip a switch.
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "body.enabled must be a boolean" }, { status: 400 });
  }

  await setFeatureEnabled(feature as FeatureId, enabled, userIdOf(payload));
  console.log(
    `[chat-features] ${feature} ${enabled ? "ENABLED" : "DISABLED"} by ${userIdOf(payload) ?? "unknown admin"}`
  );

  const flags = await getFeatureFlags();
  return NextResponse.json(
    { supportEnabled: flags.support, messagingEnabled: flags.messaging },
    { headers: NO_STORE }
  );
}
