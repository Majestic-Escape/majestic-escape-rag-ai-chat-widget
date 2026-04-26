import { NextResponse } from "next/server";
import { getChangeStreamStats } from "@/workers/changeStream";
import clientPromise from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  try {
    const client = await clientPromise;
    await client.db().command({ ping: 1 });
    dbOk = true;
  } catch (err) {
    console.error("[health] db ping failed", err);
  }
  const cs = getChangeStreamStats();
  return NextResponse.json({
    ok: dbOk && cs.isRunning,
    db: dbOk,
    changeStream: cs,
    timestamp: new Date().toISOString(),
  });
}
