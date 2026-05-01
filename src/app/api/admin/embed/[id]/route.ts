import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { embedAndSaveProperty } from "@/lib/embedder";
import { verifyToken, resolveIsAdmin } from "@/lib/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const payload = verifyToken(token);
  if (!(await resolveIsAdmin(payload))) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  await embedAndSaveProperty(new ObjectId(id));
  return NextResponse.json({ ok: true, id });
}
