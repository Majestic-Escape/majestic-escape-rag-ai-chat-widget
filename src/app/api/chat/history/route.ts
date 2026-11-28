import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import clientPromise from "@/lib/mongodb";
import { isAiEnabled } from "@/lib/aiToggle";
import { bounded } from "@/lib/bounded";
import { isExpired } from "@/lib/rag/state";
import { istToday } from "@/lib/rag/dates";
import { filterChips } from "@/lib/rag/reply";
import { chatIdentity, datedSearchEnabled, pilotLive, productionDeps, searchMode } from "@/lib/rag/runtime";
import { revalidate } from "@/lib/rag/understand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  // Gated alongside /api/chat so the AI surface closes completely rather than
  // half-open. Reading history costs no AI tokens, but leaving it live while
  // the assistant is off would still serve prior AI transcripts into a widget
  // that is not meant to show an AI tab at all.
  if (!(await isAiEnabled())) {
    return NextResponse.json({ error: "ai_disabled" }, { status: 403 });
  }

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
    : DEFAULT_LIMIT;

  // The same identity as POST /api/chat: an unverified token reads its own thread, never the plain guest one.
  const who = chatIdentity(req.headers, url.searchParams.get("guestSessionId"));
  const filter: Record<string, unknown> = {};
  if (who.userId) {
    filter.userId = new ObjectId(who.userId);
  } else if (who.guestId) {
    filter.guestSessionId = who.guestId;
  } else {
    // No identity → no history to return.
    return NextResponse.json({ messages: [] });
  }

  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);

  // bounded: a stalled database answers 500 in 2.5 s; the widget then opens without history
  const rows = await bounded(
    db
      .collection("ai_chat_messages")
      .find(filter, { projection: { _id: 0, role: 1, text: 1, createdAt: 1, properties: 1 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
  );

  // Return ascending so the client can render in chronological order.
  rows.reverse();
  // Availability is only true at the moment it was checked. Rows saved before
  // the search pipeline carry a "booked for your dates" flag that would be
  // replayed as if it were current — drop it on the way out.
  for (const row of rows) {
    if (Array.isArray(row.properties)) {
      for (const card of row.properties) {
        delete card.partiallyBooked;
        if (card.availability !== undefined) card.availability = "recheck";
      }
    }
  }
  // Filters mode: the search as it stands, so a reloaded page shows the applied filters (chips) and the editor
  // starts from them. Best effort: without it the history still loads.
  let current: { search: Record<string, unknown>; filters: unknown[] } | undefined;
  // Only for a visitor the pilot answers: outside the canary the chat gives the safe reply, so no filters either.
  if (searchMode() === "filters" && pilotLive(who)) {
    try {
      const doc = who.key ? await bounded((await productionDeps()).store.load(who.key)) : null;
      if (doc && !isExpired(doc, Date.now())) {
        const today = istToday(new Date());
        const { shownIds: _s, consentFor: _c, ...all } = revalidate(doc.state, today).state;
        const { checkIn: _i, checkOut: _o, nights: _n, ...undated } = all;
        const search = datedSearchEnabled() ? all : undated; // the same rule as the chat route
        current = { search, filters: filterChips(search, today) };
      }
    } catch {
      /* the history alone */
    }
  }
  return NextResponse.json({ messages: rows, ...(current ?? {}) });
}
