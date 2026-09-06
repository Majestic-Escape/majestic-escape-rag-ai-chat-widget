// Phase 0 cost-audit diagnostics — TEMPORARY.
//
// Railway bills this service ~88% for memory and we do not know what holds it.
// This route reports the RSS breakdown, V8 heap, event-loop delay and Mongo pool
// concurrency so the Phase 2 precompile decision is made on measurement rather
// than on the assumption that `tsx` is the culprit.
//
// Admin-only, deliberately. This is NOT on the public `/api/health`: heap sizes,
// `execArgv`, Node version and pool topology are exactly the details an attacker
// uses to fingerprint a target and size a memory-pressure attack. `/api/health`
// stays a boolean liveness check.
//
// Remove this route together with `src/lib/processMetrics.ts` once Phase 2
// concludes — it exists to answer one question, not to become permanent
// telemetry.

import { NextRequest, NextResponse } from "next/server";
import { verifyToken, resolveIsAdmin } from "@/lib/jwt";
import { getProcessMetrics } from "@/lib/processMetrics";
import { getChangeStreamStats } from "@/workers/changeStream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

export async function GET(req: NextRequest) {
  const payload = verifyToken(bearer(req));
  if (!(await resolveIsAdmin(payload))) {
    // Same shape and status as the other admin routes. Nothing about the
    // response should reveal that this endpoint is more interesting than any
    // other admin route.
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }

  // `?reset=1` restarts the event-loop-delay window, so a polling script gets
  // per-interval figures instead of an average over all of history — the mean
  // otherwise flattens out and hides any spike.
  const reset = req.nextUrl.searchParams.get("reset") === "1";

  return NextResponse.json(
    {
      ...getProcessMetrics(reset),
      // The egress hypothesis is that change-stream `getMore` polling dominates.
      // Pairing event counts with the Railway egress figure is what will confirm
      // or kill that, so it belongs in the same snapshot.
      changeStream: getChangeStreamStats(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
