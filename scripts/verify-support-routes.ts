// Checks the two support REST routes against a real (local) database:
// the transcript names the customer as they are named now, and an admin whose
// record was banned or demoted is refused even with a still-valid token; the
// delete audit names the admin from their record.
//
// Run:  npm run verify:support-routes
//       (LOCAL MongoDB only — default mongodb://127.0.0.1:27417/?replicaSet=rs0,
//        override with SUPPORT_VERIFY_MONGODB_URI; works in its own uniquely
//        named database and drops only that one)

import { MongoClient, ObjectId, type Db } from "mongodb";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";

const BASE_URI = process.env.SUPPORT_VERIFY_MONGODB_URI || "mongodb://127.0.0.1:27417/?replicaSet=rs0";
const SECRET = "verify-support-routes-secret";
const DB_NAME = `support_routes_${Date.now().toString(36)}`;

function localUriWithDb(base: string, name: string): string {
  const m = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?([^?]*)(\?.*)?$/.exec(base);
  if (!m) throw new Error("refusing non-local MongoDB URI");
  return `mongodb://${m[1]}${m[2] ?? ""}/${name}${m[4] ?? ""}`;
}
const DB_URI = localUriWithDb(BASE_URI, DB_NAME);
Object.assign(process.env, { MONGODB_URI: DB_URI, JWT_SECRET: SECRET, ADMIN_USER_IDS: "", ADMIN_EMAILS: "" });

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, info?: unknown): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${JSON.stringify(info)?.slice(0, 400)}`}`);
}
const sign = (p: Record<string, unknown>) => jwt.sign(p, SECRET, { expiresIn: "1h" });
const req = (url: string, token: string | null, method = "GET") =>
  new NextRequest(url, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function main(): Promise<void> {
  const mongo = new MongoClient(DB_URI);
  await mongo.connect();
  const db: Db = mongo.db(DB_NAME);
  try {
    const { GET } = await import("../src/app/api/support/conversations/[id]/transcript/route");
    const { DELETE } = await import("../src/app/api/admin/conversations/[id]/route");

    const userId = new ObjectId();
    const goodAdmin = new ObjectId();
    const bannedAdmin = new ObjectId();
    const demotedAdmin = new ObjectId();
    await db.collection("users").insertOne({ _id: userId, firstName: "Shrirajj", lastName: "Naik", email: "u@verify.local" });
    await db.collection("admins").insertMany([
      { _id: goodAdmin, firstName: "Admin Support", lastName: "", role: "admin", status: { active: true, banned: false } },
      { _id: bannedAdmin, firstName: "Gone", lastName: "Agent", role: "admin", status: { active: true, banned: true } },
      { _id: demotedAdmin, firstName: "Former", lastName: "Agent", role: "viewer", status: { active: true } },
    ]);
    const convo = async () => {
      const _id = new ObjectId();
      const at = new Date();
      await db.collection("support_chats").insertOne({
        _id,
        userId,
        guestSessionId: null,
        userFirstName: "Test",
        userLastName: "",
        status: "open",
        messages: [],
        createdAt: at,
        updatedAt: at,
      });
      await db.collection("support_chats_archive").insertOne({
        conversationId: _id,
        message: { _id: new ObjectId(), from: "user", authorName: "Test", text: "hello", createdAt: at },
        archivedAt: at,
      });
      return String(_id);
    };
    const params = (id: string) => ({ params: Promise.resolve({ id }) });
    // Admin tokens carry the role claim — the claim alone passes the old check.
    const adminToken = (id: ObjectId, firstName: string) => sign({ userId: String(id), firstName, role: "admin" });

    console.log("transcript");
    const id1 = await convo();
    const ownerToken = sign({ userId: String(userId), firstName: "Test" });
    const text = await (await GET(req(`http://local/api/support/conversations/${id1}/transcript`, ownerToken), params(id1))).text();
    check("RT-NAME-01 header names the customer as they are now (not the stored 'Test')", /\nUser: Shrirajj Naik\n/.test(text), text.slice(0, 300));
    check("RT-NAME-02 message lines keep the name they were written with", /\] Test: hello/.test(text), text);
    check("RT-FMT-01 the header is set apart from the first line", /─{60}\n\n\[/.test(text), text);
    const json = await (await GET(req(`http://local/api/support/conversations/${id1}/transcript?format=json`, ownerToken), params(id1))).json();
    check(
      "RT-NAME-03 JSON carries structured live names (userFirstName stays for old readers)",
      json.userFirstName === "Shrirajj" && json.userName?.first === "Shrirajj" && json.userName?.last === "Naik" && json.userName?.full === "Shrirajj Naik",
      json
    );
    const goodRes = await GET(req(`http://local/api/support/conversations/${id1}/transcript`, adminToken(goodAdmin, "Info")), params(id1));
    check("RT-SEC-01 an admin in good standing can download", goodRes.status === 200, goodRes.status);
    const bannedRes = await GET(req(`http://local/api/support/conversations/${id1}/transcript`, adminToken(bannedAdmin, "Gone")), params(id1));
    check("RT-SEC-02 a banned admin with a valid token is refused the transcript", bannedRes.status === 403, bannedRes.status);
    const demotedRes = await GET(req(`http://local/api/support/conversations/${id1}/transcript`, adminToken(demotedAdmin, "Former")), params(id1));
    check("RT-SEC-03 a demoted admin with a valid token is refused the transcript", demotedRes.status === 403, demotedRes.status);
    const strangerRes = await GET(req(`http://local/api/support/conversations/${id1}/transcript`, sign({ userId: String(new ObjectId()) })), params(id1));
    check("RT-SEC-04 another customer is refused", strangerRes.status === 403, strangerRes.status);

    await db.collection("users").deleteOne({ _id: userId });
    const orphan = await (await GET(req(`http://local/api/support/conversations/${id1}/transcript?format=json`, adminToken(goodAdmin, "Info")), params(id1))).json();
    check("RT-NAME-04 a deleted customer falls back to the stored name", orphan.userName?.first === "Test" && orphan.userFirstName === "Test", orphan);

    console.log("delete");
    const id2 = await convo();
    const refused = await DELETE(req(`http://local/api/admin/conversations/${id2}`, adminToken(bannedAdmin, "Gone"), "DELETE"), params(id2));
    const stillThere = await db.collection("support_chats").countDocuments({ _id: new ObjectId(id2) });
    check("RT-SEC-05 a banned admin cannot delete (nothing deleted, no audit)", refused.status === 401 && stillThere === 1 && (await db.collection("support_audit").countDocuments()) === 0, { status: refused.status, stillThere });
    const ok = await DELETE(req(`http://local/api/admin/conversations/${id2}`, adminToken(goodAdmin, "Info"), "DELETE"), params(id2));
    const audit = await db.collection("support_audit").findOne({ conversationId: new ObjectId(id2) });
    check("RT-AUD-01 delete works and the audit names the admin from their record ('Admin Support', not the token's 'Info')", ok.status === 200 && audit?.actorName === "Admin Support", { status: ok.status, actorName: audit?.actorName });
    const gone = (await db.collection("support_chats").countDocuments({ _id: new ObjectId(id2) })) + (await db.collection("support_chats_archive").countDocuments({ conversationId: new ObjectId(id2) }));
    check("RT-AUD-02 the conversation and its archive are gone", gone === 0, gone);
  } finally {
    await db.dropDatabase().catch(() => {});
    await mongo.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
