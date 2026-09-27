// Asserts the /support socket contract (src/lib/supportSocket.ts) against the
// REAL namespace — the same code server.ts mounts — on an ephemeral port.
//
// Run:  npm run verify:support
//       (needs a LOCAL MongoDB replica set; default mongodb://127.0.0.1:27417/?replicaSet=rs0,
//        override with SUPPORT_VERIFY_MONGODB_URI)
//
// This repo has no test runner by design (see CLAUDE.md), so this follows the
// standalone-script convention of scripts/verify-ai-toggle.ts. It refuses any
// non-local or SRV URI, works in a database it creates with a unique name,
// and drops only that database when it finishes.
//
// Every check has a name from the plan's test matrix (WS-SEC-…, REG-…); the
// summary lists passed and failed checks separately.

import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { Server as IOServer } from "socket.io";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { MongoClient, ObjectId, type Db } from "mongodb";
import jwt from "jsonwebtoken";

// ─── Harness ────────────────────────────────────────────────────────────────

const BASE_URI = process.env.SUPPORT_VERIFY_MONGODB_URI || "mongodb://127.0.0.1:27417/?replicaSet=rs0";
const SECRET = "verify-support-secret";
const DB_NAME = `support_verify_${Date.now().toString(36)}`;

function localUriWithDb(base: string, db: string): string {
  const m = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?([^?]*)(\?.*)?$/.exec(base);
  if (!m) throw new Error(`refusing non-local MongoDB URI (${base.replace(/\/\/[^@]*@/, "//<cred>@")})`);
  return `mongodb://${m[1]}${m[2] ?? ""}/${db}${m[4] ?? ""}`;
}

const DB_URI = localUriWithDb(BASE_URI, DB_NAME);
Object.assign(process.env, {
  MONGODB_URI: DB_URI,
  JWT_SECRET: SECRET,
  ADMIN_USER_IDS: "",
  ADMIN_EMAILS: "",
});

const results: { name: string; ok: boolean; info?: unknown }[] = [];
function check(name: string, ok: boolean, info?: unknown): void {
  results.push({ name, ok, info: ok ? undefined : info });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${JSON.stringify(info)}`}`);
}

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let url = "";
let db: Db;
const sockets: ClientSocket[] = [];

function token(payload: Record<string, unknown>): string {
  return jwt.sign(payload, SECRET, { expiresIn: "1h" });
}

interface Connection {
  socket?: ClientSocket;
  refused?: string;
  // first occurrence of events the server sends right after connecting —
  // listened for from the start so none can be missed
  joined: Promise<any>;
  adminInit: Promise<any>;
}

// Connects; resolves with the socket or with the refusal message.
function connect(auth: unknown): Promise<Connection> {
  return new Promise((resolve) => {
    const socket = connectClient(`${url}/support`, {
      auth: auth as Record<string, unknown>,
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    const joined = new Promise<any>((res) => socket.once("support:joined", res));
    const adminInit = new Promise<any>((res) => socket.once("support:admin-init", res));
    socket.once("connect", () => resolve({ socket, joined, adminInit }));
    socket.once("connect_error", (err) => resolve({ refused: err.message, joined, adminInit }));
  });
}

function emitAck(socket: ClientSocket, event: string, payload: unknown, ms = 3000): Promise<any> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), ms);
    socket.emit(event, payload, (r: unknown) => {
      clearTimeout(t);
      resolve(r);
    });
  });
}

function nextEvent(socket: ClientSocket, event: string, ms = 3000, match: (p: any) => boolean = () => true): Promise<any> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      socket.off(event, on);
      resolve(undefined);
    }, ms);
    const on = (p: any) => {
      if (!match(p)) return;
      clearTimeout(t);
      socket.off(event, on);
      resolve(p);
    };
    socket.on(event, on);
  });
}

async function snapshot(): Promise<string> {
  const chats = await db.collection("support_chats").find({}).sort({ _id: 1 }).toArray();
  const ai = await db.collection("ai_chat_messages").find({}).sort({ _id: 1 }).toArray();
  return JSON.stringify({ chats, ai });
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ADMIN_ID = new ObjectId();
const U1 = new ObjectId();
const U2 = new ObjectId();
const ATTACKER = new ObjectId();
const adminToken = token({ userId: String(ADMIN_ID), firstName: "Ops" });
const u1Token = token({ userId: String(U1), firstName: "Una", tokenVersion: 0, admin: 0 });
const u2Token = token({ userId: String(U2), firstName: "Dos", tokenVersion: 0, admin: 0 });
const attackerToken = token({ userId: String(ATTACKER), firstName: "Mallory", tokenVersion: 0, admin: 0 });

async function seed(): Promise<{ victimConvId: ObjectId }> {
  await db.collection("admins").insertOne({ _id: ADMIN_ID, firstName: "Ops", role: "admin", status: { active: true, banned: false } });
  const now = new Date();
  const victimConvId = new ObjectId();
  await db.collection("support_chats").insertOne({
    _id: victimConvId,
    userId: null,
    guestSessionId: "g_victim",
    userFirstName: "Guest",
    status: "pending",
    assignedAdminId: null,
    assignedAdminName: null,
    assignmentHistory: [],
    messages: [{ _id: new ObjectId(), from: "user", authorId: null, authorName: "You", text: "VICTIM-SECRET", createdAt: now, readBy: [] }],
    rating: null,
    resolvedAt: null,
    ratingDismissedAt: null,
    createdAt: now,
    updatedAt: now,
    unreadCounts: { user: 0, admin: 1 },
  });
  await db.collection("ai_chat_messages").insertMany([
    { guestSessionId: "g_victim", userId: null, role: "user", text: "VICTIM-AI", createdAt: now },
    { guestSessionId: "g_other", userId: null, role: "user", text: "OTHER-AI", createdAt: now },
  ]);
  return { victimConvId };
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

async function securityScenarios(victimConvId: ObjectId): Promise<void> {
  console.log("\nWS-SEC-01 handshake guest id injection");
  const before = await snapshot();

  const anon = await connect({ guestSessionId: { $ne: null } });
  const anonJoined = anon.socket ? await Promise.race([anon.joined, sleep(1500).then(() => undefined)]) : undefined;
  check("WS-SEC-01a operator guest id without a token is refused", !!anon.refused && !anonJoined, { refused: anon.refused, joined: anonJoined });

  const withJwt = await connect({ token: attackerToken, guestSessionId: { $ne: null } });
  const attackerJoined = withJwt.socket ? await Promise.race([withJwt.joined, sleep(3000).then(() => undefined)]) : undefined;
  const victim = await db.collection("support_chats").findOne({ _id: victimConvId });
  const victimAi = await db.collection("ai_chat_messages").find({ userId: ATTACKER }).toArray();
  check(
    "WS-SEC-01b operator guest id with a token claims nothing (victim thread + AI history untouched)",
    !!victim && victim.userId === null && victim.guestSessionId === "g_victim" && victimAi.length === 0,
    { victimUserId: victim?.userId, victimGuest: victim?.guestSessionId, aiMoved: victimAi.length }
  );
  const leaked = JSON.stringify(attackerJoined ?? {}).includes("VICTIM-SECRET");
  check("WS-SEC-01b attacker never receives the victim's history", !leaked, attackerJoined);

  for (const [label, value] of [
    ["array", ["g_victim"]],
    ["number", 42],
    ["over-long", "g".repeat(101)],
    ["operator characters", "g_victim$ne"],
    ["empty", ""],
  ] as const) {
    const r = await connect({ guestSessionId: value });
    check(`WS-SEC-01c ${label} guest id is treated as no identity (refused)`, !!r.refused, r.refused ?? "connected");
  }

  const after = await snapshot();
  // WS-SEC-01b's attacker legitimately gets its OWN conversation on connect
  // (eager creation, pre-A); compare everything else.
  const strip = (s: string) => {
    const o = JSON.parse(s);
    o.chats = o.chats.filter((c: any) => c.userId !== String(ATTACKER));
    return JSON.stringify(o);
  };
  check("WS-SEC-01 no other data changed", strip(before) === strip(after));
}

async function malformedPayloadScenarios(ownConvId: string, u1: ClientSocket, admin: ClientSocket): Promise<void> {
  console.log("\nWS-SEC-02 every event × malformed payloads");
  const before = await snapshot();
  const bad: unknown[] = [null, [], "str", 42, true, {}, { conversationId: { $ne: null } }, { conversationId: "zz" }, { conversationId: ownConvId.toUpperCase() + "0" }];
  const events = ["support:message", "support:read", "support:typing", "support:assign", "support:resolve", "support:reopen", "support:rate", "support:fetch-history", "support:rating-dismissed"];
  const unhandledBefore = unhandled.length;
  let silentOk = 0;
  for (const socket of [u1, admin]) {
    for (const event of events) {
      for (const payload of bad) {
        // with a real callback: must answer ok:false (or not answer for fire-and-forget events)
        const r = await emitAck(socket, event, payload, 700);
        if (r && r.ok === true) silentOk++;
        // with a non-function "ack": must not throw inside the handler
        socket.emit(event, payload, "not-a-function");
      }
    }
  }
  await sleep(500);
  check("WS-SEC-02 no malformed payload is ever acknowledged as ok", silentOk === 0, { silentOk });
  check("WS-SEC-02 non-function ack arguments never raise", unhandled.length === unhandledBefore, unhandled.slice(unhandledBefore));
  const after = await snapshot();
  check("WS-SEC-02 malformed payloads change nothing in the database", before === after);

  const r1 = await emitAck(u1, "support:message", { conversationId: ownConvId, text: "hi", clientMessageId: { $gt: "" } });
  check("WS-SEC-02 operator clientMessageId rejected", r1?.ok === false, r1);
  const r2 = await emitAck(u1, "support:message", { conversationId: ownConvId, text: "hi", clientMessageId: "c_" + "x".repeat(70) });
  check("WS-SEC-02 oversized clientMessageId rejected", r2?.ok === false, r2);
  const r3 = await emitAck(u1, "support:message", { conversationId: ownConvId, text: { $ne: "" } });
  check("WS-SEC-02 non-string text rejected", r3?.ok === false, r3);
}

async function ownershipScenarios(u1ConvId: string, u1: ClientSocket, u2: ClientSocket, admin: ClientSocket): Promise<void> {
  console.log("\nWS-SEC ownership on reads, receipts, dismissal, typing, history, rating, messages");
  const chats = db.collection("support_chats");
  const _id = new ObjectId(u1ConvId);
  await chats.updateOne({ _id }, { $set: { "unreadCounts.user": 3, "unreadCounts.admin": 4 } });

  u2.emit("support:read", { conversationId: u1ConvId, lastMessageId: { $ne: null } });
  await sleep(400);
  let doc = await chats.findOne({ _id });
  check("WS-SEC read receipt from another customer changes nothing", doc?.unreadCounts?.user === 3 && doc?.unreadCounts?.admin === 4, doc?.unreadCounts);

  const d2 = await emitAck(u2, "support:rating-dismissed", { conversationId: u1ConvId });
  doc = await chats.findOne({ _id });
  check("WS-SEC rating dismissal by another customer is refused", d2?.ok === false && !doc?.ratingDismissedAt, { d2, at: doc?.ratingDismissedAt });

  const dA = await emitAck(admin, "support:rating-dismissed", { conversationId: u1ConvId });
  doc = await chats.findOne({ _id });
  check("WS-SEC rating dismissal is owner-only (admin refused)", dA?.ok === false && !doc?.ratingDismissedAt, { dA, at: doc?.ratingDismissedAt });

  const typingSeen = nextEvent(u1, "support:typing", 800);
  u2.emit("support:typing", { conversationId: u1ConvId, isTyping: true });
  check("WS-SEC typing into another customer's conversation is not broadcast", (await typingSeen) === undefined);

  const h2 = await emitAck(u2, "support:fetch-history", { conversationId: u1ConvId });
  check("WS-SEC history of another customer's conversation is forbidden", h2?.ok === false, h2);

  const m2 = await emitAck(u2, "support:message", { conversationId: u1ConvId, text: "intrude" });
  doc = await chats.findOne({ _id });
  check("WS-SEC message into another customer's conversation is refused", m2?.ok === false && !JSON.stringify(doc?.messages).includes("intrude"), m2);

  const own = await emitAck(u1, "support:rating-dismissed", { conversationId: u1ConvId });
  doc = await chats.findOne({ _id });
  check("WS-SEC owner can dismiss their own rating prompt", own?.ok === true && !!doc?.ratingDismissedAt, own);

  u1.emit("support:read", { conversationId: u1ConvId });
  await sleep(400);
  doc = await chats.findOne({ _id });
  check("WS-SEC owner's read receipt resets the customer counter only", doc?.unreadCounts?.user === 0 && doc?.unreadCounts?.admin === 4, doc?.unreadCounts);
}

async function identityScenarios(): Promise<void> {
  console.log("\nWS-SEC-04 malformed token subjects / missing identity");
  const badSubject = token({ userId: "not-an-object-id", firstName: "Nobody" });
  const r1 = await connect({ token: badSubject });
  check("WS-SEC-04 token without a valid user id and no guest id is refused", !!r1.refused, r1.refused ?? "connected");

  const r2 = await connect({ token: badSubject, guestSessionId: "g_subject_test" });
  const joined = r2.socket ? await Promise.race([r2.joined, sleep(3000).then(() => undefined)]) : undefined;
  const doc = joined ? await db.collection("support_chats").findOne({ _id: new ObjectId(joined.conversationId) }) : null;
  check(
    "WS-SEC-04 such a token with a valid guest id acts only as that guest",
    !!doc && doc.userId === null && doc.guestSessionId === "g_subject_test",
    { joined: joined?.conversationId, userId: doc?.userId, guest: doc?.guestSessionId }
  );

  const r3 = await connect({ token: 12345 });
  check("WS-SEC-04 non-string token and no guest id is refused", !!r3.refused, r3.refused ?? "connected");
}

async function regressionScenarios(): Promise<{ u1: ClientSocket; u2: ClientSocket; admin: ClientSocket; u1ConvId: string }> {
  console.log("\nREG-01 legitimate flow still works");
  const c1 = await connect({ token: u1Token, guestSessionId: "g_u1_device" });
  const j1 = await Promise.race([c1.joined, sleep(4000).then(() => undefined)]);
  check("REG-01 customer connects and joins", !!c1.socket && !!j1?.conversationId, { refused: c1.refused, j1 });
  const u1 = c1.socket!;
  const u1ConvId: string = j1.conversationId;

  const c2 = await connect({ token: u2Token, guestSessionId: "g_u2_device" });
  await Promise.race([c2.joined, sleep(4000)]);
  const u2 = c2.socket!;

  const ca = await connect({ token: adminToken });
  const init = await Promise.race([ca.adminInit, sleep(4000).then(() => undefined)]);
  check("REG-01 admin connects and receives the inbox", !!ca.socket && Array.isArray(init?.conversations), { refused: ca.refused });
  const admin = ca.socket!;

  const echo = nextEvent(u1, "support:message", 4000, (p) => p?.message?.text === "hello support");
  const sent = await emitAck(u1, "support:message", { conversationId: u1ConvId, text: "hello support", clientMessageId: "c_reg_1" });
  check("REG-01 customer message acknowledged and echoed", sent?.ok === true && !!(await echo), sent);

  const assigned = await emitAck(admin, "support:assign", { conversationId: u1ConvId });
  check("REG-01 admin can open (assign) the conversation", assigned?.ok === true, assigned);

  const reply = nextEvent(u1, "support:message", 4000, (p) => p?.message?.text === "agent reply");
  const r = await emitAck(admin, "support:message", { conversationId: u1ConvId, text: "agent reply", clientMessageId: "c_reg_2" });
  check("REG-01 admin reply reaches the customer", r?.ok === true && !!(await reply), r);

  const hist = nextEvent(admin, "support:history", 4000);
  const h = await emitAck(admin, "support:fetch-history", { conversationId: u1ConvId });
  check("REG-01 admin can fetch the history", h?.ok === true && Array.isArray((await hist)?.messages), h);

  const typing = nextEvent(u1, "support:typing", 2000);
  admin.emit("support:typing", { conversationId: u1ConvId, isTyping: "yes" });
  const t = await typing;
  check("REG-01 admin typing reaches the customer, isTyping coerced to boolean", t?.isTyping === false && t?.conversationId === u1ConvId, t);

  return { u1, u2, admin, u1ConvId };
}

async function ratingScenario(u1: ClientSocket, admin: ClientSocket, u1ConvId: string): Promise<void> {
  console.log("\nREG-02 resolve → rate");
  const res = await emitAck(admin, "support:resolve", { conversationId: u1ConvId });
  check("REG-02 admin resolves", res?.ok === true, res);
  const bad = await emitAck(u1, "support:rate", { conversationId: u1ConvId, stars: 4.5 });
  check("REG-02 non-integer stars rejected", bad?.ok === false, bad);
  const badComment = await emitAck(u1, "support:rate", { conversationId: u1ConvId, stars: 4, comment: { $ne: "" } });
  check("REG-02 non-string comment rejected", badComment?.ok === false, badComment);
  const ok = await emitAck(u1, "support:rate", { conversationId: u1ConvId, stars: 5, comment: "great" });
  const doc = await db.collection("support_chats").findOne({ _id: new ObjectId(u1ConvId) });
  check("REG-02 owner rates the resolved conversation", ok?.ok === true && doc?.rating?.stars === 5 && doc?.rating?.comment === "great", { ok, rating: doc?.rating });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mongo = new MongoClient(DB_URI);
  await mongo.connect();
  db = mongo.db(DB_NAME);

  const { mountSupportNamespace } = await import("../src/lib/supportSocket");
  const server: HttpServer = createServer();
  const io = new IOServer(server, { cors: { origin: true } });
  mountSupportNamespace(io);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`verify-support-socket: ${url}, database ${DB_NAME}`);

  try {
    const { victimConvId } = await seed();
    const { u1, u2, admin, u1ConvId } = await regressionScenarios();
    await securityScenarios(victimConvId);
    await malformedPayloadScenarios(u1ConvId, u1, admin);
    await ownershipScenarios(u1ConvId, u1, u2, admin);
    await ratingScenario(u1, admin, u1ConvId);
    await identityScenarios();
  } catch (err) {
    check("harness completed without throwing", false, String(err));
  } finally {
    for (const s of sockets) s.disconnect();
    io.close();
    server.close();
    await db.dropDatabase().catch(() => {});
    await mongo.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (process.env.SUPPORT_VERIFY_EVIDENCE) {
    const { writeFileSync } = await import("fs");
    writeFileSync(process.env.SUPPORT_VERIFY_EVIDENCE, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
