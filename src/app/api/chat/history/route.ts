import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import clientPromise from "@/lib/mongodb";
import { verifyToken } from "@/lib/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
    : DEFAULT_LIMIT;

  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const jwt = bearer ? verifyToken(bearer) : null;
  const userIdRaw =
    typeof jwt?.userId === "string"
      ? jwt.userId
      : typeof jwt?.id === "string"
      ? jwt.id
      : null;
  const guestSessionId = url.searchParams.get("guestSessionId");

  const filter: Record<string, unknown> = {};
  if (userIdRaw) {
    try {
      filter.userId = new ObjectId(userIdRaw);
    } catch {
      return NextResponse.json({ error: "invalid token identity" }, { status: 401 });
    }
  } else if (guestSessionId && typeof guestSessionId === "string" && guestSessionId.length <= 100) {
    filter.guestSessionId = guestSessionId;
  } else {
    // No identity → no history to return.
    return NextResponse.json({ messages: [] });
  }

  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);

  const rows = await db
    .collection("ai_chat_messages")
    .find(filter, { projection: { _id: 0, role: 1, text: 1, createdAt: 1, properties: 1 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  // Return ascending so the client can render in chronological order.
  rows.reverse();
  return NextResponse.json({ messages: rows });
}
