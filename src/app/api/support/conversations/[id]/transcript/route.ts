import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import clientPromise, { appDbName } from "@/lib/mongodb";
import { verifyToken, resolveIsAdmin } from "@/lib/jwt";
import { adminStanding, lookupUserNames, personName } from "@/lib/supportNames";

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
  let isAdmin = await resolveIsAdmin(jwt);

  const client = await clientPromise;
  const db = client.db(appDbName());

  // An admin token outlives a ban or demotion (7 days); the record decides.
  if (isAdmin && userIdRaw && /^[0-9a-fA-F]{24}$/.test(userIdRaw)) {
    const standing = await adminStanding(db, new ObjectId(userIdRaw));
    if (standing.known && !standing.allowed) isAdmin = false;
  }

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

  // The customer as they are named now (an admin may have renamed them); the
  // copy stored on the conversation is for a record that no longer exists.
  // Message lines keep the names they were written with.
  const live = chat.userId instanceof ObjectId ? (await lookupUserNames(db, [chat.userId])).get(String(chat.userId)) : undefined;
  const userName = live ?? personName({ firstName: chat.userFirstName, lastName: chat.userLastName });

  if (format === "json") {
    return NextResponse.json({
      conversationId: id,
      status: chat.status,
      userFirstName: userName?.first ?? chat.userFirstName ?? null,
      userName: userName ? { first: userName.first, last: userName.last, full: userName.full } : null,
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
    `User: ${userName?.full ?? (chat.userId ? "User" : "Guest")}`,
    `Created: ${new Date(chat.createdAt).toISOString()}`,
    chat.resolvedAt ? `Resolved: ${new Date(chat.resolvedAt).toISOString()}` : null,
    chat.rating ? `Rating: ${chat.rating.stars}/5${chat.rating.comment ? ` — ${chat.rating.comment}` : ""}` : null,
    "",
    "─".repeat(60),
    "",
    "",
  ]
    // Only the missing lines go; the blank ones set the header apart.
    .filter((line) => line !== null)
    .join("\n");

  const body = header + all.map(formatLine).join("\n") + "\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="support-${id}.txt"`,
    },
  });
}
