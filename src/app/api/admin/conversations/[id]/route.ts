import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import clientPromise from "@/lib/mongodb";
import { verifyToken, resolveIsAdmin } from "@/lib/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidObjectId(s: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(s);
}

function safeUserIdFromJwt(payload: { id?: unknown; userId?: unknown } | null): ObjectId | null {
  const raw = (payload?.userId as string | undefined) ?? (payload?.id as string | undefined);
  if (!raw || typeof raw !== "string") return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "invalid conversation id" }, { status: 400 });
  }

  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const payload = verifyToken(token);
  if (!(await resolveIsAdmin(payload))) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }

  const conversationId = new ObjectId(id);
  const adminId = safeUserIdFromJwt(payload);
  const adminName =
    typeof payload?.firstName === "string" ? payload.firstName.trim() : null;

  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);

  const chats = db.collection("support_chats");
  const archive = db.collection("support_chats_archive");
  const audit = db.collection("support_audit");

  const existing = await chats.findOne({ _id: conversationId });
  if (!existing) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  const archiveCount = await archive.countDocuments({ conversationId });
  const liveCount = Array.isArray(existing.messages) ? existing.messages.length : 0;

  await archive.deleteMany({ conversationId });
  await chats.deleteOne({ _id: conversationId });

  await audit.insertOne({
    conversationId,
    actorId: adminId,
    actorName: adminName,
    action: "delete",
    details: {
      messagesDeleted: liveCount,
      archiveDeleted: archiveCount,
      userId: existing.userId ? String(existing.userId) : null,
      guestSessionId: existing.guestSessionId ?? null,
    },
    ts: new Date(),
  });

  return NextResponse.json({
    ok: true,
    deleted: { messages: liveCount, archive: archiveCount },
  });
}
