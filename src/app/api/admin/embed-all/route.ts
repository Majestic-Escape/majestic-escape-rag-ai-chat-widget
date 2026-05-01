import { NextRequest, NextResponse } from "next/server";
import { runCatchUpSync } from "@/workers/catchUpSync";
import { verifyToken, resolveIsAdmin } from "@/lib/jwt";
import { tryAcquireLock, releaseLock } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOCK_NAME = "embed-all";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const payload = verifyToken(token);
  if (!(await resolveIsAdmin(payload))) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }
  if (!tryAcquireLock(LOCK_NAME)) {
    return NextResponse.json(
      { error: "embed-all already running" },
      { status: 409 }
    );
  }
  try {
    const stats = await runCatchUpSync();
    return NextResponse.json({ ok: true, ...stats });
  } finally {
    releaseLock(LOCK_NAME);
  }
}
