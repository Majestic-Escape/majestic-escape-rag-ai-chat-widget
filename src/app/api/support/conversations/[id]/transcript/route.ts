import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import clientPromise from "@/lib/mongodb";
import { verifyToken, isAdminPayload } from "@/lib/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ServerMessage {
  _id: unknown;
  from: "user" | "admin" | "system";
  authorName: string | null;
  text: string;
  createdAt: Date;
  kind?: string;
}

function isValidObjectId(s: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(s);
}

function formatLine(m: ServerMessage): string {
  const ts = new Date(m.createdAt).toISOString().replace("T", " ").slice(0, 19);
  if (m.from === "system") return `[${ts}] --- ${m.text} ---`;
  const who = m.authorName ?? (m.from === "admin" ? "Support" : "User");
  return `[${ts}] ${who}: ${m.text}`;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidObjectId(id)) {
    return NextResponse.json({ error: "invalid conversation id" }, { status: 400 });
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "json" ? "json" : "text";
  const guestSessionId = url.searchParams.get("guestSessionId");

  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const jwt = bearer ? verifyToken(bearer) : null;
  const userIdRaw =
    typeof jwt?.userId === "string"
      ? jwt.userId
      : typeof jwt?.id === "string"
      ? jwt.id
      : null;
  const isAdmin = isAdminPayload(jwt);

  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);

  const conversationId = new ObjectId(id);
  const chat = await db.collection("support_chats").findOne({ _id: conversationId });
  if (!chat) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  // Authorisation check
  let authorised = false;
  if (isAdmin) {
    authorised = true;
  } else if (userIdRaw && chat.userId && String(chat.userId) === userIdRaw) {
    authorised = true;
  } else if (
    !userIdRaw &&
    guestSessionId &&
    chat.guestSessionId &&
    chat.guestSessionId === guestSessionId
  ) {
    authorised = true;
  }
  if (!authorised) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Archive contains every message ever sent (immutable log written on every
  // send). Read from there to guarantee the full history is exported.
  const archived = await db
    .collection("support_chats_archive")
    .find({ conversationId })
    .sort({ "message.createdAt": 1 })
    .toArray();
  const all = archived.map((a) => a.message as ServerMessage);

  if (format === "json") {
    return NextResponse.json({
      conversationId: id,
      status: chat.status,
      userFirstName: chat.userFirstName,
      createdAt: chat.createdAt,
      resolvedAt: chat.resolvedAt,
      rating: chat.rating,
      messages: all.map((m) => ({
        from: m.from,
        authorName: m.authorName,
        text: m.text,
        createdAt: m.createdAt,
        kind: m.kind,
      })),
    });
  }

  const header = [
    `Majestic Escape — Support Conversation Transcript`,
    `Conversation: ${id}`,
    `Status: ${chat.status}`,
    `User: ${chat.userFirstName ?? (chat.userId ? "User" : "Guest")}`,
    `Created: ${new Date(chat.createdAt).toISOString()}`,
    chat.resolvedAt ? `Resolved: ${new Date(chat.resolvedAt).toISOString()}` : "",
    chat.rating ? `Rating: ${chat.rating.stars}/5${chat.rating.comment ? ` — ${chat.rating.comment}` : ""}` : "",
    "",
    "─".repeat(60),
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const body = header + all.map(formatLine).join("\n") + "\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="support-${id}.txt"`,
    },
  });
}
