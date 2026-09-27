// Asserts the /support socket contract (src/lib/supportSocket.ts) against the
// REAL namespace — the same code server.ts mounts — on ephemeral ports.
//
// Run:  npm run verify:support
//       (needs a LOCAL MongoDB replica set; default mongodb://127.0.0.1:27417/?replicaSet=rs0,
//        override with SUPPORT_VERIFY_MONGODB_URI; SUPPORT_VERIFY_ONLY=<prefix> runs one group)
//
// This repo has no test runner by design (see CLAUDE.md), so this follows the
// standalone-script convention of scripts/verify-ai-toggle.ts. It refuses any
// non-local or SRV URI, works in a database it creates with a unique name,
// and drops only that database when it finishes.
//
// Races are exercised with CONTROLLED interleavings: the script wraps the
// driver's Collection methods (and Socket.IO's broadcast) in this process
// and pauses one operation at an exact point while another runs. Every check
// has a name from the plan's test matrix; the summary lists passed and failed
// checks, and SUPPORT_VERIFY_EVIDENCE=<file> writes them as JSON.

import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { Server as IOServer } from "socket.io";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { Collection, MongoClient, ObjectId, type Db } from "mongodb";
import jwt from "jsonwebtoken";

// ─── Harness ────────────────────────────────────────────────────────────────

const BASE_URI = process.env.SUPPORT_VERIFY_MONGODB_URI || "mongodb://127.0.0.1:27417/?replicaSet=rs0";
const SECRET = "verify-support-secret";
const DB_NAME = `support_verify_${Date.now().toString(36)}`;
const ONLY = process.env.SUPPORT_VERIFY_ONLY || "";

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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${JSON.stringify(info)?.slice(0, 600)}`}`);
}

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let url = "";
let db: Db;
let mongo: MongoClient;
const sockets: ClientSocket[] = [];

function token(payload: Record<string, unknown>, expiresIn: number | string = "1h"): string {
  return jwt.sign(payload, SECRET, { expiresIn } as jwt.SignOptions);
}

interface Conn {
  socket?: ClientSocket;
  refused?: string;
  joined: Promise<any>;
  adminInit: Promise<any>;
  log: { event: string; args: any[] }[];
}

// Connects; resolves with the socket or with the refusal message. Every event
// the socket receives is recorded in `log`, in arrival order.
function connect(auth: unknown, opts: { transports?: string[] } = {}): Promise<Conn> {
  return new Promise((resolve) => {
    const socket = connectClient(`${url}/support`, {
      auth: auth as Record<string, unknown>,
      transports: (opts.transports as any) ?? ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    const log: Conn["log"] = [];
    socket.onAny((event, ...args) => log.push({ event, args }));
    const joined = new Promise<any>((res) => socket.once("support:joined", res));
    const adminInit = new Promise<any>((res) => socket.once("support:admin-init", res));
    socket.once("connect", () => resolve({ socket, joined, adminInit, log }));
    socket.once("connect_error", (err) => resolve({ refused: err.message, joined, adminInit, log }));
  });
}

async function joinedOf(c: Conn, ms = 4000): Promise<any> {
  return Promise.race([c.joined, sleep(ms).then(() => undefined)]);
}

function emitAck(socket: ClientSocket, event: string, payload: unknown, ms = 4000): Promise<any> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), ms);
    socket.emit(event, payload, (r: unknown) => {
      clearTimeout(t);
      resolve(r);
    });
  });
}

function nextEvent(socket: ClientSocket, event: string, ms = 4000, match: (p: any) => boolean = () => true): Promise<any> {
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

async function until(fn: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  return !!(await fn());
}

async function snapshot(): Promise<string> {
  const chats = await db.collection("support_chats").find({}).sort({ _id: 1 }).toArray();
  const ai = await db.collection("ai_chat_messages").find({}).sort({ _id: 1 }).toArray();
  return JSON.stringify({ chats, ai });
}

const chatsColl = () => db.collection("support_chats");

// ─── Controlled interleavings ───────────────────────────────────────────────

type Method = "findOneAndUpdate" | "insertOne" | "updateMany" | "findOne";
interface Hook {
  method: Method;
  collection: string;
  match?: (args: any[]) => boolean;
  before?: () => Promise<void>;
  fail?: () => unknown;
  times: number;
  used: number;
}
const hooks: Hook[] = [];

function installHookPlumbing(): void {
  for (const method of ["findOneAndUpdate", "insertOne", "updateMany", "findOne"] as Method[]) {
    const original = (Collection.prototype as any)[method];
    (Collection.prototype as any)[method] = async function (this: Collection, ...args: any[]) {
      const h = hooks.find(
        (x) => x.method === method && x.collection === this.collectionName && x.used < x.times && (!x.match || x.match(args))
      );
      if (h) {
        h.used++;
        if (h.before) await h.before();
        if (h.fail) throw h.fail();
      }
      return original.apply(this, args);
    };
  }
}

function hook(spec: Omit<Hook, "used" | "times"> & { times?: number }): Hook {
  const h: Hook = { times: 1, used: 0, ...spec };
  hooks.push(h);
  return h;
}

function clearHooks(): void {
  hooks.length = 0;
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

let broadcastFailure: { event: string; remaining: number } | null = null;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ADMIN_ID = new ObjectId();
const ADMIN2_ID = new ObjectId();
const adminToken = token({ userId: String(ADMIN_ID), firstName: "Ops" });
const admin2Token = token({ userId: String(ADMIN2_ID), firstName: "Second" });

let userSeq = 0;
async function makeUser(first = "Cust", last = "Omer"): Promise<{ id: ObjectId; token: string; first: string; last: string }> {
  const id = new ObjectId();
  userSeq++;
  await db.collection("users").insertMany([{ _id: id, firstName: first, lastName: last, email: `u${userSeq}@verify.local` }]);
  // the claim a customer's token carries (deliberately stale in name tests)
  return { id, token: token({ userId: String(id), firstName: "Tokenname", tokenVersion: 0, admin: 0 }), first, last };
}

function customer(u: { token: string }, extra: Record<string, unknown> = {}) {
  return connect({ token: u.token, guestSessionId: `g_dev_${u.token.slice(-12).replace(/[^A-Za-z0-9]/g, "")}`, proto: 2, ...extra });
}

async function seedAdmins(): Promise<void> {
  await db.collection("admins").insertMany([
    { _id: ADMIN_ID, firstName: "Ops", lastName: "Team", role: "admin", status: { active: true, banned: false } },
    { _id: ADMIN2_ID, firstName: "Second", lastName: "Agent", role: "admin", status: { active: true, banned: false } },
  ]);
}

async function adminConn(t = adminToken): Promise<Conn> {
  const c = await connect({ token: t });
  await Promise.race([c.adminInit, sleep(4000)]);
  return c;
}

// Opens a draft and sends the first message; returns the conversation id.
async function startConversation(u: { token: string }, text = "hello support"): Promise<{ c: Conn; id: string }> {
  const c = await customer(u);
  await joinedOf(c);
  const ack = await emitAck(c.socket!, "support:message", { conversationId: null, text, clientMessageId: `c_${new ObjectId()}` });
  return { c, id: ack.conversationId };
}

// ─── A0: security (kept) ─────────────────────────────────────────────────────

async function a0Security(): Promise<void> {
  console.log("\nWS-SEC-01 handshake guest id injection");
  const victimConvId = new ObjectId();
  const now = new Date();
  await chatsColl().insertMany([
    {
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
    },
  ]);
  await db.collection("ai_chat_messages").insertMany([
    { guestSessionId: "g_victim", userId: null, role: "user", text: "VICTIM-AI", createdAt: now },
    { guestSessionId: "g_other", userId: null, role: "user", text: "OTHER-AI", createdAt: now },
  ]);
  const attacker = await makeUser("Mallory", "M");
  const before = await snapshot();

  for (const proto of [1, 2]) {
    const anon = await connect({ guestSessionId: { $ne: null }, proto });
    const j = anon.socket ? await joinedOf(anon, 1500) : undefined;
    check(`WS-SEC-01a operator guest id without a token is refused (proto ${proto})`, !!anon.refused && !j, { refused: anon.refused, j });
  }
  const withJwt = await connect({ token: attacker.token, guestSessionId: { $ne: null }, proto: 2 });
  const attackerJoined = withJwt.socket ? await joinedOf(withJwt, 3000) : undefined;
  const victim = await chatsColl().findOne({ _id: victimConvId });
  const aiMoved = await db.collection("ai_chat_messages").countDocuments({ userId: attacker.id });
  check(
    "WS-SEC-01b operator guest id with a token claims nothing (victim thread + AI history untouched)",
    !!victim && victim.userId === null && victim.guestSessionId === "g_victim" && aiMoved === 0,
    { victimUserId: victim?.userId, victimGuest: victim?.guestSessionId, aiMoved }
  );
  check("WS-SEC-01b attacker never receives the victim's history", !JSON.stringify(attackerJoined ?? {}).includes("VICTIM-SECRET"), attackerJoined);
  for (const [label, value] of [
    ["array", ["g_victim"]],
    ["number", 42],
    ["over-long", "g".repeat(101)],
    ["operator characters", "g_victim$ne"],
    ["empty", ""],
  ] as const) {
    const r = await connect({ guestSessionId: value, proto: 2 });
    check(`WS-SEC-01c ${label} guest id is treated as no identity (refused)`, !!r.refused, r.refused ?? "connected");
  }
  check("WS-SEC-01 no data changed (a proto-2 open writes nothing)", before === (await snapshot()));
}

async function a0Malformed(): Promise<void> {
  console.log("\nWS-SEC-02 every event × malformed payloads");
  const u = await makeUser("Mal", "Formed");
  const { c, id } = await startConversation(u);
  const admin = await adminConn();
  const before = await snapshot();
  const bad: unknown[] = [null, [], "str", 42, true, {}, { conversationId: { $ne: null } }, { conversationId: "zz" }, { conversationId: id.toUpperCase() + "0" }];
  const events = [
    "support:message",
    "support:read",
    "support:typing",
    "support:assign",
    "support:resolve",
    "support:reopen",
    "support:rate",
    "support:fetch-history",
    "support:rating-dismissed",
    "support:admin-more",
  ];
  const unhandledBefore = unhandled.length;
  let silentOk = 0;
  for (const socket of [c.socket!, admin.socket!]) {
    for (const event of events) {
      for (const payload of bad) {
        const r = await emitAck(socket, event, payload, 500);
        // admin-more with no cursor is a valid first page; everything else must fail
        if (r && r.ok === true && !(event === "support:admin-more" && isPlainObject(payload) && !("before" in (payload as object)))) silentOk++;
        socket.emit(event, payload, "not-a-function");
      }
    }
  }
  await sleep(500);
  check("WS-SEC-02 no malformed payload is ever acknowledged as ok", silentOk === 0, { silentOk });
  check("WS-SEC-02 non-function ack arguments never raise", unhandled.length === unhandledBefore, unhandled.slice(unhandledBefore));
  check("WS-SEC-02 malformed payloads change nothing in the database", before === (await snapshot()));
  const r1 = await emitAck(c.socket!, "support:message", { conversationId: id, text: "hi", clientMessageId: { $gt: "" } });
  check("WS-SEC-02 operator clientMessageId rejected", r1?.ok === false, r1);
  const r2 = await emitAck(c.socket!, "support:message", { conversationId: id, text: "hi", clientMessageId: "c_" + "x".repeat(70) });
  check("WS-SEC-02 oversized clientMessageId rejected", r2?.ok === false, r2);
  const r3 = await emitAck(c.socket!, "support:message", { conversationId: id, text: { $ne: "" } });
  check("WS-SEC-02 non-string text rejected", r3?.ok === false, r3);
  const r4 = await emitAck(admin.socket!, "support:message", { conversationId: null, text: "admin draft?" });
  check("WS-SEC-02 an agent can't send with a null conversation id", r4?.ok === false, r4);
  const r5 = await emitAck(admin.socket!, "support:admin-more", { before: { updatedAt: { $gt: "" }, id } });
  check("WS-SEC-02 malformed inbox cursor rejected", r5?.ok === false, r5);
}

async function a0Ownership(): Promise<void> {
  console.log("\nWS-SEC ownership on reads, receipts, dismissal, typing, history, rating, messages");
  const u1 = await makeUser("Una", "Uno");
  const u2 = await makeUser("Dos", "Two");
  const { c: c1, id } = await startConversation(u1);
  const c2 = await customer(u2);
  await joinedOf(c2);
  const admin = await adminConn();
  const _id = new ObjectId(id);
  await chatsColl().updateOne({ _id }, { $set: { "unreadCounts.user": 3 } });
  const adminUnread = (await chatsColl().findOne({ _id }))?.unreadCounts?.admin;

  c2.socket!.emit("support:read", { conversationId: id, lastMessageId: { $ne: null } });
  await sleep(400);
  let doc = await chatsColl().findOne({ _id });
  check("WS-SEC read receipt from another customer changes nothing", doc?.unreadCounts?.user === 3 && doc?.unreadCounts?.admin === adminUnread, doc?.unreadCounts);
  const d2 = await emitAck(c2.socket!, "support:rating-dismissed", { conversationId: id });
  const dA = await emitAck(admin.socket!, "support:rating-dismissed", { conversationId: id });
  doc = await chatsColl().findOne({ _id });
  check("WS-SEC rating dismissal by another customer or an agent is refused (owner only)", d2?.ok === false && dA?.ok === false && !doc?.ratingDismissedAt, { d2, dA });
  const typingSeen = nextEvent(c1.socket!, "support:typing", 800);
  c2.socket!.emit("support:typing", { conversationId: id, isTyping: true });
  check("WS-SEC-03 typing into another customer's conversation is not broadcast", (await typingSeen) === undefined);
  const h2 = await emitAck(c2.socket!, "support:fetch-history", { conversationId: id });
  check("WS-SEC-03 history of another customer's conversation is forbidden", h2?.ok === false, h2);
  // …and it never joined the room: an agent reply doesn't reach it
  await emitAck(admin.socket!, "support:assign", { conversationId: id });
  const leak = nextEvent(c2.socket!, "support:message", 1200, (p) => p?.conversationId === id);
  await emitAck(admin.socket!, "support:message", { conversationId: id, text: "for Una only", clientMessageId: "c_own_1" });
  check("WS-SEC-03 a refused socket never joins the room", (await leak) === undefined);
  const viewer = await adminConn(admin2Token);
  const hist = await emitAck(viewer.socket!, "support:fetch-history", { conversationId: id });
  const live = nextEvent(viewer.socket!, "support:message", 3000, (p) => p?.message?.text === "after the history");
  await emitAck(c1.socket!, "support:message", { conversationId: id, text: "after the history", clientMessageId: "c_own_hist" });
  check("WS-SEC-03b an agent who only fetched the history receives later messages (join, then read)", hist?.ok === true && !!(await live), hist);
  const m2 = await emitAck(c2.socket!, "support:message", { conversationId: id, text: "intrude" });
  doc = await chatsColl().findOne({ _id });
  check("WS-SEC message into another customer's conversation is refused", m2?.ok === false && !JSON.stringify(doc?.messages).includes("intrude"), m2);
  const own = await emitAck(c1.socket!, "support:rating-dismissed", { conversationId: id });
  check("WS-SEC owner can dismiss their own rating prompt", own?.ok === true, own);
  c1.socket!.emit("support:read", { conversationId: id });
  await sleep(400);
  doc = await chatsColl().findOne({ _id });
  check("WS-SEC owner's read receipt resets the customer counter only", doc?.unreadCounts?.user === 0, doc?.unreadCounts);
}

async function a0Identity(): Promise<void> {
  console.log("\nWS-SEC-04 malformed token subjects / missing identity");
  const badSubject = token({ userId: "not-an-object-id", firstName: "Nobody" });
  const r1 = await connect({ token: badSubject, proto: 2 });
  check("WS-SEC-04 token without a valid user id and no guest id is refused", !!r1.refused, r1.refused ?? "connected");
  const before = await chatsColl().countDocuments();
  const r2 = await connect({ token: badSubject, guestSessionId: "g_subject_test", proto: 1 });
  const err = r2.socket ? await nextEvent(r2.socket, "support:error", 3000) : undefined;
  const leakedUser = await chatsColl().countDocuments({ userFirstName: "Nobody" });
  check(
    "WS-SEC-04 such a token with a guest id is only that guest — and a guest can't create a conversation",
    !!r2.socket && /sign in/i.test(err?.reason ?? "") && (await chatsColl().countDocuments()) === before && leakedUser === 0,
    { refused: r2.refused, err }
  );
  const r3 = await connect({ token: 12345, proto: 2 });
  check("WS-SEC-04 non-string token and no guest id is refused", !!r3.refused, r3.refused ?? "connected");
  const r4 = await connect({ token: badSubject, guestSessionId: "g_subject_test2", proto: 2 });
  await joinedOf(r4);
  const send = r4.socket ? await emitAck(r4.socket, "support:message", { conversationId: null, text: "hi" }) : undefined;
  check("WS-SEC-04 a guest draft can't create a conversation either", send?.ok === false && /sign in/i.test(send?.error ?? ""), send);
}

// ─── A: lifecycle ────────────────────────────────────────────────────────────

async function lifeDraft(): Promise<void> {
  console.log("\nWS-LIFE-01 opening Support writes nothing; announced only with the first message");
  const u = await makeUser("Dora", "Draft");
  const admin = await adminConn();
  const before = await chatsColl().countDocuments();
  const c = await customer(u);
  const j = await joinedOf(c);
  await sleep(300);
  check("WS-LIFE-01 draft join: conversationId null, no document written", j?.conversationId === null && (await chatsColl().countDocuments()) === before, j);
  check("WS-LIFE-01 no agent event on open", !admin.log.some((e) => e.event === "support:new-conversation"));

  const order: string[] = [];
  c.socket!.onAny((event) => order.push(event));
  const newConv = nextEvent(admin.socket!, "support:new-conversation", 4000);
  const ack = await emitAck(c.socket!, "support:message", { conversationId: null, text: "first words", clientMessageId: "c_life_1" });
  order.push("ack");
  const row = await newConv;
  const doc = ack?.conversationId ? await chatsColl().findOne({ _id: new ObjectId(ack.conversationId) }) : null;
  check("WS-LIFE-01 first message creates exactly one conversation", ack?.ok === true && !!doc && (await chatsColl().countDocuments()) === before + 1, ack);
  check("WS-LIFE-01 created by the first message, with a DB-unique active key", doc?.createdBy === "first-message" && doc?.activeKey === `u:${u.id}`, { createdBy: doc?.createdBy, key: doc?.activeKey });
  check(
    "WS-LIFE-01 agent gets the full row: live full name, the customer's words, unread 1",
    row?.conversation?.userName === "Dora Draft" && row?.conversation?.userFirstName === "Dora" && row?.conversation?.lastMessage?.text === "first words" && row?.conversation?.unread === 1,
    row
  );
  await sleep(300);
  const firstIdx = (e: string) => order.indexOf(e);
  const autoAt = order.findIndex((e, i) => e === "support:message" && i > firstIdx("support:message"));
  check(
    "WS-ORDER-01 sender sees started → echo → auto-ack → ack",
    firstIdx("support:started") >= 0 && firstIdx("support:started") < firstIdx("support:message") && autoAt > firstIdx("support:message") && order.indexOf("ack") > autoAt,
    order
  );
  const autoMsgs = (doc?.messages ?? []).filter((m: any) => m.kind === "auto").length;
  check("WS-LIFE-01 one auto-acknowledgement, and it doesn't reach the agents' inbox", autoMsgs === 1 && admin.log.filter((e) => e.event === "support:conversation-updated" && e.args[0]?.lastMessage?.kind === "auto").length === 0);
  const firstAgentUpdate = admin.log.find((e) => e.event === "support:conversation-updated")?.args[0];
  check("WS-LIFE-01 conversation-updated still follows the first message (older consoles)", firstAgentUpdate?.lastMessage?.text === "first words", firstAgentUpdate);
}

async function lifeRace(): Promise<void> {
  console.log("\nWS-LIFE-02 concurrent first messages → one conversation, one announcement, one auto-ack");
  const admin = await adminConn();
  let bad = 0;
  const failures: unknown[] = [];
  for (let round = 0; round < 20; round++) {
    const u = await makeUser(`Racer${round}`, "R");
    const tabs = await Promise.all([customer(u), customer(u), customer(u)]);
    await Promise.all(tabs.map((t) => joinedOf(t)));
    const announced: any[] = [];
    const onNew = (p: any) => {
      if (p?.conversation?.userId === String(u.id)) announced.push(p);
    };
    admin.socket!.on("support:new-conversation", onNew);
    const acks = await Promise.all(
      tabs.map((t, i) => emitAck(t.socket!, "support:message", { conversationId: null, text: `hi ${i}`, clientMessageId: `c_race_${round}_${i}` }))
    );
    await sleep(250);
    admin.socket!.off("support:new-conversation", onNew);
    const docs = await chatsColl().find({ userId: u.id }).toArray();
    const d = docs[0];
    const ok =
      docs.length === 1 &&
      acks.every((a) => a?.ok === true && a.conversationId === String(d?._id)) &&
      announced.length === 1 &&
      (d?.messages ?? []).filter((m: any) => m.kind === "auto").length === 1 &&
      d?.unreadCounts?.admin === 3 &&
      d?.userMsgs === 3;
    if (!ok) {
      bad++;
      failures.push({ round, docs: docs.length, announced: announced.length, unread: d?.unreadCounts, acks });
    }
    for (const t of tabs) t.socket!.disconnect();
  }
  check("WS-LIFE-02 20 rounds × 3 tabs: 1 doc, 1 announcement, 1 auto-ack, unread = 3", bad === 0, failures.slice(0, 2));
}

async function lifeMultiProcess(): Promise<void> {
  console.log("\nWS-MULTI-01 creation is unique in the database, not just in this process");
  // Another process wins the race: its document appears right before ours is
  // inserted (after our lookup found none).
  const u = await makeUser("Paula", "Process");
  const competitor = new ObjectId();
  hook({
    method: "insertOne",
    collection: "support_chats",
    match: (args) => args[0]?.activeKey === `u:${u.id}`,
    before: async () => {
      await chatsColl().insertMany([
        {
          _id: competitor,
          userId: u.id,
          guestSessionId: null,
          userFirstName: "Paula",
          status: "pending",
          assignedAdminId: null,
          assignedAdminName: null,
          assignmentHistory: [],
          messages: [],
          rating: null,
          resolvedAt: null,
          ratingDismissedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          unreadCounts: { user: 0, admin: 0 },
          activeKey: `u:${u.id}`,
          createdBy: "first-message",
          rev: 0,
          userMsgs: 0,
          readUserIdx: { admin: 0 },
        },
      ]);
    },
  });
  const c = await customer(u);
  await joinedOf(c);
  const ack = await emitAck(c.socket!, "support:message", { conversationId: null, text: "which one?", clientMessageId: "c_multi_1" });
  clearHooks();
  const docs = await chatsColl().find({ userId: u.id }).toArray();
  check("WS-MULTI-01 losing insert attaches to the winner (1 doc, message in it)", docs.length === 1 && ack?.conversationId === String(competitor) && docs[0].messages.length >= 1, { docs: docs.length, ack });
  // Read after a creation: the server builds its indexes before its first
  // insert, so the collection and index exist by now even when this group
  // runs alone on a fresh database.
  const indexes = await chatsColl().indexes();
  const active = indexes.find((i) => i.name === "active_key_unique");
  check("WS-MULTI-01 unique partial index on activeKey exists", !!active?.unique && !!active?.partialFilterExpression, active);

  console.log("\nWS-LIFE-06 one open conversation per customer: reopen refused while another is open");
  const v = await makeUser("Vera", "Reopen");
  const admin = await adminConn();
  const first = await startConversation(v, "first thread");
  await emitAck(admin.socket!, "support:assign", { conversationId: first.id });
  await emitAck(admin.socket!, "support:resolve", { conversationId: first.id });
  const resolvedDoc = await chatsColl().findOne({ _id: new ObjectId(first.id) });
  check("WS-LIFE-06 resolve removes the active key", resolvedDoc?.status === "resolved" && resolvedDoc?.activeKey === undefined, resolvedDoc?.activeKey);
  await emitAck(first.c.socket!, "support:rating-dismissed", { conversationId: first.id });
  const second = await startConversation(v, "second thread");
  const reopen = await emitAck(admin.socket!, "support:reopen", { conversationId: first.id });
  check("WS-LIFE-06 reopen is refused while the customer has another open conversation", reopen?.ok === false && /already has an open conversation/.test(reopen?.error ?? ""), reopen);
  await emitAck(admin.socket!, "support:assign", { conversationId: second.id });
  await emitAck(admin.socket!, "support:resolve", { conversationId: second.id });
  const reopen2 = await emitAck(admin.socket!, "support:reopen", { conversationId: first.id });
  const reopened = await chatsColl().findOne({ _id: new ObjectId(first.id) });
  check("WS-LIFE-06 reopen works once the other is resolved, and restores the key", reopen2?.ok === true && reopened?.status === "open" && reopened?.activeKey === `u:${v.id}`, { reopen2, key: reopened?.activeKey });
}

async function lifeDraftTabs(): Promise<void> {
  console.log("\nWS-LIFE-03 a second tab still in its draft hears everything");
  const u = await makeUser("Tabi", "Two");
  const admin = await adminConn();
  const a = await customer(u);
  const b = await customer(u);
  await Promise.all([joinedOf(a), joinedOf(b)]);
  const started = nextEvent(b.socket!, "support:started", 4000);
  const echo = nextEvent(b.socket!, "support:message", 4000, (p) => p?.message?.text === "from tab A");
  const ack = await emitAck(a.socket!, "support:message", { conversationId: null, text: "from tab A", clientMessageId: "c_tabs_1" });
  const s = await started;
  check("WS-LIFE-03 tab B gets support:started with the id", s?.conversationId === ack?.conversationId, s);
  check("WS-LIFE-03 tab B gets the echo", !!(await echo));
  await emitAck(admin.socket!, "support:assign", { conversationId: ack.conversationId });
  const reply = nextEvent(b.socket!, "support:message", 4000, (p) => p?.message?.text === "agent to both");
  await emitAck(admin.socket!, "support:message", { conversationId: ack.conversationId, text: "agent to both", clientMessageId: "c_tabs_2" });
  check("WS-LIFE-03 tab B receives the agent's reply", !!(await reply));
}

async function lifeStarts(): Promise<void> {
  console.log("\nWS-LIFE-04 starts are never dropped");
  const u = await makeUser("Rita", "Rating");
  const admin = await adminConn();
  const { c, id } = await startConversation(u);
  await emitAck(admin.socket!, "support:assign", { conversationId: id });
  await emitAck(admin.socket!, "support:resolve", { conversationId: id });
  c.socket!.disconnect();
  const again = await customer(u);
  const j = await joinedOf(again);
  check("WS-LIFE-04 a resolved, unrated conversation comes back with the rating prompt", j?.conversationId === id && j?.awaitingRating === true, j);
  // Skip right away: dismiss (acked) then start within the old 500 ms window
  const draft = nextEvent(again.socket!, "support:joined", 4000, (p) => p?.conversationId === null);
  again.socket!.emit("support:start", {});
  await emitAck(again.socket!, "support:rating-dismissed", { conversationId: id });
  again.socket!.emit("support:start", {});
  check("WS-LIFE-04 dismiss → start 100 ms later → a fresh draft (the old debounce stranded this)", !!(await draft));
  const joinsBefore = again.log.filter((e) => e.event === "support:joined").length;
  for (let i = 0; i < 30; i++) again.socket!.emit("support:start", {});
  await sleep(2500);
  const joins = again.log.filter((e) => e.event === "support:joined").length - joinsBefore;
  const last = again.log.filter((e) => e.event === "support:joined").slice(-1)[0]?.args[0];
  check("WS-LIFE-04 30 starts coalesce into a few joins, the last one current", joins >= 1 && joins <= 8 && last?.conversationId === null, { joins, last });

  // Join failure on connect is retried by the client's own first start.
  const w = await makeUser("Wanda", "Retry");
  hook({
    method: "findOne",
    collection: "support_chats",
    match: (args) => String(args[0]?.userId) === String(w.id) && args[0]?.status === "resolved",
    fail: () => new Error("simulated outage"),
  });
  const r = await connect({ token: w.token, guestSessionId: "g_retry_dev", proto: 2 });
  const errEvent = r.socket ? await nextEvent(r.socket, "support:error", 3000) : undefined;
  r.socket?.emit("support:start", {});
  const recovered = r.socket ? await nextEvent(r.socket, "support:joined", 4000) : undefined;
  clearHooks();
  check("WS-LIFE-04 a failed connect-time join is reported and the next start answers", !!errEvent && recovered?.conversationId === null, { errEvent, recovered });
}

async function lifeCrash(): Promise<void> {
  console.log("\nWS-CRASH-01 a crash after the commit, before any event, is repaired");
  const u = await makeUser("Cora", "Crash");
  const c = await customer(u);
  await joinedOf(c);
  broadcastFailure = { event: "support:message", remaining: 1 };
  const ack = await emitAck(c.socket!, "support:message", { conversationId: null, text: "committed, never announced", clientMessageId: "c_crash_1" });
  broadcastFailure = null;
  const docs = await chatsColl().find({ userId: u.id }).toArray();
  check("WS-CRASH-01 the message committed although its events failed", ack?.ok === false && docs.length === 1 && docs[0].messages.some((m: any) => m.text === "committed, never announced"), { ack, docs: docs.length });
  const admin = await adminConn();
  const init = await admin.adminInit;
  check("WS-CRASH-01 the next inbox load has it", (init?.conversations ?? []).some((r: any) => r.conversationId === String(docs[0]?._id)));
  c.socket!.disconnect();
  const back = await customer(u);
  const j = await joinedOf(back);
  check("WS-CRASH-01 the customer's reconnect joins the same conversation — no new document", j?.conversationId === String(docs[0]?._id) && (await chatsColl().countDocuments({ userId: u.id })) === 1, j);
  const resend = await emitAck(back.socket!, "support:message", { conversationId: j.conversationId, text: "committed, never announced", clientMessageId: "c_crash_1" });
  check("WS-IDEM-06 the resend after the crash is recognised, not stored twice", resend?.ok === true && resend?.duplicate === true, resend);
}

// ─── A: idempotency ──────────────────────────────────────────────────────────

async function idempotency(): Promise<void> {
  console.log("\nWS-IDEM retries");
  const u = await makeUser("Ida", "Dempotent");
  const admin = await adminConn();
  const { c, id } = await startConversation(u, "opening line");
  const _id = new ObjectId(id);
  const watcher = await adminConn(admin2Token);
  let echoes = 0;
  watcher.socket!.on("support:conversation-updated", (p: any) => {
    if (p?.conversationId === id && p?.lastMessage?.text === "same words") echoes++;
  });
  const first = await emitAck(c.socket!, "support:message", { conversationId: id, text: "same words", clientMessageId: "c_idem_1" });
  const unreadAfterFirst = (await chatsColl().findOne({ _id }))?.unreadCounts?.admin;
  const again = await emitAck(c.socket!, "support:message", { conversationId: id, text: "same words", clientMessageId: "c_idem_1" });
  await sleep(300);
  const doc = await chatsColl().findOne({ _id });
  check(
    "WS-IDEM-01 lost ack: the resend returns the original, no second message, no broadcast, unread unchanged",
    first?.ok && again?.ok && again?.duplicate === true && again?.messageId === first?.messageId &&
      doc!.messages.filter((m: any) => m.clientMessageId === "c_idem_1").length === 1 && echoes === 1 && doc?.unreadCounts?.admin === unreadAfterFirst,
    { first, again, echoes }
  );
  const tab2 = await customer(u);
  await joinedOf(tab2);
  const [x1, x2] = await Promise.all([
    emitAck(c.socket!, "support:message", { conversationId: id, text: "twin", clientMessageId: "c_idem_twin" }),
    emitAck(tab2.socket!, "support:message", { conversationId: id, text: "twin", clientMessageId: "c_idem_twin" }),
  ]);
  const twin = await chatsColl().findOne({ _id });
  check(
    "WS-IDEM-08 the same message id sent at once from two tabs is stored once (dedupe is in the write)",
    x1?.ok && x2?.ok && [x1, x2].filter((r: any) => r.duplicate).length === 1 && twin!.messages.filter((m: any) => m.clientMessageId === "c_idem_twin").length === 1,
    { x1, x2 }
  );
  const conflict = await emitAck(c.socket!, "support:message", { conversationId: id, text: "different words", clientMessageId: "c_idem_1" });
  check("WS-IDEM-04 same id with different text is a conflict", conflict?.ok === false && /different message/.test(conflict?.error ?? ""), conflict);

  await emitAck(admin.socket!, "support:assign", { conversationId: id });
  await emitAck(c.socket!, "support:message", { conversationId: id, text: "before resolve", clientMessageId: "c_idem_2" });
  await emitAck(admin.socket!, "support:resolve", { conversationId: id });
  const late = await emitAck(c.socket!, "support:message", { conversationId: id, text: "before resolve", clientMessageId: "c_idem_2" });
  check("WS-IDEM-02 committed then resolved: the resend is still acknowledged as delivered", late?.ok === true && late?.duplicate === true, late);

  const d = await makeUser("Nula", "Draft");
  const dc = await customer(d);
  await joinedOf(dc);
  const n1 = await emitAck(dc.socket!, "support:message", { conversationId: null, text: "null id first", clientMessageId: "c_idem_3" });
  const n2 = await emitAck(dc.socket!, "support:message", { conversationId: null, text: "null id first", clientMessageId: "c_idem_3" });
  const dd = await chatsColl().find({ userId: d.id }).toArray();
  check(
    "WS-IDEM-03 a null-id first message resent: one conversation, one message",
    n2?.duplicate === true && n2?.conversationId === n1?.conversationId && dd.length === 1 && dd[0].messages.filter((m: any) => m.clientMessageId === "c_idem_3").length === 1,
    { n1, n2, docs: dd.length }
  );

  // Outside the window (the original evicted from the ring): a resend is new.
  const e = await makeUser("Evie", "Evicted");
  const ec = await startConversation(e, "will be evicted");
  const eid = new ObjectId(ec.id);
  await emitAck(ec.c.socket!, "support:message", { conversationId: ec.id, text: "old message", clientMessageId: "c_idem_5" });
  const filler = Array.from({ length: 500 }, (_, i) => ({ _id: new ObjectId(), from: "system", authorId: null, authorName: null, text: `filler ${i}`, createdAt: new Date(), readBy: [], kind: "join" }));
  await chatsColl().updateOne({ _id: eid }, { $push: { messages: { $each: filler, $slice: -500 } } } as any);
  const outside = await emitAck(ec.c.socket!, "support:message", { conversationId: ec.id, text: "old message", clientMessageId: "c_idem_5" });
  check("WS-IDEM-05 outside the window (evicted) a resend is a new message — documented bound", outside?.ok === true && !outside?.duplicate, outside);

  // The cap keeps any retry window inside the ring.
  // System lines aren't limited per sender (two agents handing a conversation
  // back and forth), so they are what the per-conversation cap is for.
  const k = await makeUser("Kappa", "Cap");
  const kc = await startConversation(k, "cap test");
  const agentA = await adminConn();
  const agentB = await adminConn(admin2Token);
  let refusedAt = -1;
  let refusal = "";
  for (let i = 0; i < 130; i++) {
    const r = await emitAck(i % 2 ? agentB.socket! : agentA.socket!, "support:assign", { conversationId: kc.id }, 3000);
    if (r?.ok === false) {
      refusedAt = i;
      refusal = r.error ?? "";
      break;
    }
  }
  const kdoc = await chatsColl().findOne({ _id: new ObjectId(kc.id) });
  const stillInRing = (kdoc?.messages ?? []).some((m: any) => m.text === "cap test");
  check(
    "WS-IDEM-07 appends to one conversation are capped per minute (so a 2-minute retry can't be evicted)",
    refusedAt > 100 && refusedAt <= 120 && /very busy/.test(refusal) && stillInRing && (kdoc?.messages?.length ?? 0) <= 122,
    { refusedAt, refusal, stillInRing, ring: kdoc?.messages?.length }
  );
}

// ─── A: races with controlled interleavings ─────────────────────────────────

async function races(): Promise<void> {
  console.log("\nWS-RACE controlled interleavings");
  const admin = await adminConn();
  const admin2 = await adminConn(admin2Token);

  {
    const u = await makeUser("Mira", "Message");
    const { c, id } = await startConversation(u);
    await emitAck(admin.socket!, "support:assign", { conversationId: id });
    hook({
      method: "findOneAndUpdate",
      collection: "support_chats",
      match: (args) => args[0]?.["messages.clientMessageId"]?.$ne === "c_race_msg",
      before: async () => {
        await emitAck(admin.socket!, "support:resolve", { conversationId: id });
      },
    });
    const r = await emitAck(c.socket!, "support:message", { conversationId: id, text: "racing the resolve", clientMessageId: "c_race_msg" });
    clearHooks();
    const doc = await chatsColl().findOne({ _id: new ObjectId(id) });
    check("WS-RACE-01 message ∥ resolve: the message is refused, not added to a resolved conversation", r?.ok === false && /closed/.test(r?.error ?? "") && !doc!.messages.some((m: any) => m.text === "racing the resolve"), r);
  }
  {
    const u = await makeUser("Asa", "Assign");
    const { id } = await startConversation(u);
    hook({
      method: "findOneAndUpdate",
      collection: "support_chats",
      match: (args) => "assignedAdminId" in (args[0] ?? {}) && !args[0]?.status?.$eq,
      before: async () => {
        await emitAck(admin2.socket!, "support:resolve", { conversationId: id });
      },
    });
    const r = await emitAck(admin.socket!, "support:assign", { conversationId: id });
    clearHooks();
    const doc = await chatsColl().findOne({ _id: new ObjectId(id) });
    const joinsAfterResolve = doc!.messages.slice(doc!.messages.findIndex((m: any) => m.kind === "resolve")).filter((m: any) => m.kind === "join").length;
    check("WS-RACE-02 assign ∥ resolve: stays resolved, no join line after the resolve", r?.ok === false && doc?.status === "resolved" && joinsAfterResolve === 0, { r, status: doc?.status });
  }
  {
    const u = await makeUser("Duo", "Agents");
    const { id } = await startConversation(u);
    const g = gate();
    let paused = false;
    hook({
      method: "findOneAndUpdate",
      collection: "support_chats",
      match: (args) => "assignedAdminId" in (args[0] ?? {}) && args[1]?.[0]?.$set?.assignedAdminName?.$literal === "Ops",
      before: async () => {
        paused = true;
        await g.wait;
      },
    });
    const first = emitAck(admin.socket!, "support:assign", { conversationId: id });
    await until(() => paused);
    const second = await emitAck(admin2.socket!, "support:assign", { conversationId: id });
    g.open();
    const firstResult = await first;
    clearHooks();
    const doc = await chatsColl().findOne({ _id: new ObjectId(id) });
    const lines = doc!.messages.filter((m: any) => m.kind === "join" || m.kind === "handover").map((m: any) => m.text);
    check(
      "WS-RACE-03 two agents open it at once: one join, then one handover, no duplicate join",
      second?.ok && firstResult?.ok && lines.length === 2 && /Second joined the chat$/.test(lines[0]) && /Ops joined the chat \(taking over from Second\)/.test(lines[1]) && String(doc?.assignedAdminId) === String(ADMIN_ID),
      { lines, second, firstResult }
    );
  }
  {
    const u = await makeUser("Rae", "Rate");
    const { c, id } = await startConversation(u);
    await emitAck(admin.socket!, "support:assign", { conversationId: id });
    await emitAck(admin.socket!, "support:resolve", { conversationId: id });
    hook({
      method: "findOneAndUpdate",
      collection: "support_chats",
      match: (args) => !!args[1]?.$set?.rating,
      before: async () => {
        await emitAck(admin.socket!, "support:reopen", { conversationId: id });
      },
    });
    const r = await emitAck(c.socket!, "support:rate", { conversationId: id, stars: 5 });
    clearHooks();
    const doc = await chatsColl().findOne({ _id: new ObjectId(id) });
    check("WS-RACE-04 rate ∥ reopen: the rating is refused on the reopened conversation", r?.ok === false && doc?.status === "open" && !doc?.rating, { r, rating: doc?.rating });
  }
  {
    // claim ∥ guest send
    const guestId = "g_claim_race";
    const now = new Date();
    const convId = new ObjectId();
    await chatsColl().insertMany([
      { _id: convId, userId: null, guestSessionId: guestId, userFirstName: "Guest", status: "open", assignedAdminId: null, assignedAdminName: null, assignmentHistory: [], messages: [{ _id: new ObjectId(), from: "user", authorId: null, authorName: "You", text: "guest words", createdAt: now, readBy: [] }], rating: null, resolvedAt: null, ratingDismissedAt: null, createdAt: now, updatedAt: now, unreadCounts: { user: 0, admin: 1 } },
    ]);
    const guest = await connect({ guestSessionId: guestId, proto: 2 });
    await joinedOf(guest);
    const u = await makeUser("Claire", "Claim");
    hook({
      method: "findOneAndUpdate",
      collection: "support_chats",
      match: (args) => args[0]?.guestSessionId === guestId && args[0]?.["messages.clientMessageId"]?.$ne === "c_claim_race",
      before: async () => {
        const claimer = await connect({ token: u.token, guestSessionId: guestId, proto: 2 });
        await joinedOf(claimer);
      },
    });
    const r = await emitAck(guest.socket!, "support:message", { conversationId: String(convId), text: "sent while claimed", clientMessageId: "c_claim_race" });
    clearHooks();
    const doc = await chatsColl().findOne({ _id: convId });
    check("WS-RACE-05 claim ∥ guest send: after the claim the guest socket can't write into it", r?.ok === false && String(doc?.userId) === String(u.id) && !doc!.messages.some((m: any) => m.text === "sent while claimed"), { r, owner: doc?.userId });
  }
}

// ─── A: sign-in claim ────────────────────────────────────────────────────────

async function claims(): Promise<void> {
  console.log("\nWS-CLAIM guest → account");
  const admin = await adminConn();
  const seedGuest = async (guestId: string, text: string) => {
    const now = new Date();
    const convId = new ObjectId();
    await chatsColl().insertMany([
      { _id: convId, userId: null, guestSessionId: guestId, userFirstName: "Guest", status: "open", assignedAdminId: null, assignedAdminName: null, assignmentHistory: [], messages: [{ _id: new ObjectId(), from: "user", authorId: null, authorName: "You", text, createdAt: now, readBy: [] }], rating: null, resolvedAt: null, ratingDismissedAt: null, createdAt: now, updatedAt: now, unreadCounts: { user: 0, admin: 1 } },
    ]);
    await db.collection("ai_chat_messages").insertMany([
      { guestSessionId: guestId, userId: null, role: "user", text: `${text}-ai-1`, createdAt: now },
      { guestSessionId: guestId, userId: null, role: "model", text: `${text}-ai-2`, createdAt: now },
    ]);
    return convId;
  };

  {
    const guestId = "g_two_accounts";
    const convId = await seedGuest(guestId, "shared device");
    const a = await makeUser("Anna", "A");
    const b = await makeUser("Bob", "B");
    const [ca, cb] = await Promise.all([connect({ token: a.token, guestSessionId: guestId, proto: 2 }), connect({ token: b.token, guestSessionId: guestId, proto: 2 })]);
    await Promise.all([joinedOf(ca), joinedOf(cb)]);
    const doc = await chatsColl().findOne({ _id: convId });
    const aiOwners = await db.collection("ai_chat_messages").distinct("userId", { text: /^shared device-ai/ });
    check(
      "WS-CLAIM-01 two accounts on one guest id: support + AI history end up with ONE of them, never split",
      !!doc?.userId && aiOwners.length === 1 && String(aiOwners[0]) === String(doc!.userId),
      { chatOwner: doc?.userId, aiOwners }
    );
  }
  {
    const guestId = "g_old_socket";
    const convId = await seedGuest(guestId, "old tab");
    const guest = await connect({ guestSessionId: guestId, proto: 2 });
    const gj = await joinedOf(guest);
    const u = await makeUser("Ollie", "Old");
    const cu = await connect({ token: u.token, guestSessionId: guestId, proto: 2 });
    const uj = await joinedOf(cu);
    await emitAck(admin.socket!, "support:assign", { conversationId: String(convId) });
    const toGuest = nextEvent(guest.socket!, "support:message", 1200, (p) => p?.message?.text === "private to the account");
    const toUser = nextEvent(cu.socket!, "support:message", 3000, (p) => p?.message?.text === "private to the account");
    await emitAck(admin.socket!, "support:message", { conversationId: String(convId), text: "private to the account", clientMessageId: "c_claim_2" });
    check("WS-CLAIM-02 the account joins the claimed conversation", gj?.conversationId === String(convId) && uj?.conversationId === String(convId), { gj: gj?.conversationId, uj: uj?.conversationId });
    check("WS-CLAIM-02/03 the old guest-only socket stops receiving it after the claim", (await toGuest) === undefined && !!(await toUser));
  }
  {
    const guestId = "g_claim_fail";
    const convId = await seedGuest(guestId, "atomic");
    const u = await makeUser("Theo", "Transaction");
    hook({
      method: "updateMany",
      collection: "ai_chat_messages",
      match: (args) => args[0]?.guestSessionId === guestId,
      fail: () => new Error("simulated failure between the two writes"),
    });
    const cu = await connect({ token: u.token, guestSessionId: guestId, proto: 2 });
    const err = cu.socket ? await nextEvent(cu.socket, "support:error", 3000) : undefined;
    clearHooks();
    const doc = await chatsColl().findOne({ _id: convId });
    const aiMoved = await db.collection("ai_chat_messages").countDocuments({ text: /^atomic-ai/, userId: u.id });
    check("WS-CLAIM-04 a failure between the two migration writes moves neither", !!err && doc?.userId === null && doc?.guestSessionId === guestId && aiMoved === 0, { err, owner: doc?.userId, aiMoved });
    cu.socket?.disconnect();
    const retry = await connect({ token: u.token, guestSessionId: guestId, proto: 2 });
    const rj = await joinedOf(retry);
    const after = await chatsColl().findOne({ _id: convId });
    const aiAfter = await db.collection("ai_chat_messages").countDocuments({ text: /^atomic-ai/, userId: u.id });
    check("WS-CLAIM-04 the next connection claims both", rj?.conversationId === String(convId) && String(after?.userId) === String(u.id) && aiAfter === 2, { rj, aiAfter });
  }
  {
    const guestId = "g_claim_history";
    const convId = await seedGuest(guestId, "history race");
    const guest = await connect({ guestSessionId: guestId, proto: 2 });
    await joinedOf(guest);
    const u = await makeUser("Hana", "History");
    hook({
      method: "findOne",
      collection: "support_chats",
      match: (args) => args[0]?.guestSessionId === guestId && String(args[0]?._id) === String(convId) && !args[1]?.projection,
      before: async () => {
        const claimer = await connect({ token: u.token, guestSessionId: guestId, proto: 2 });
        await joinedOf(claimer);
      },
    });
    const h = await emitAck(guest.socket!, "support:fetch-history", { conversationId: String(convId) });
    clearHooks();
    check("WS-CLAIM-05 a history read racing the claim returns nothing to the guest socket", h?.ok === false && !guest.log.some((e) => e.event === "support:history"), h);
  }
}

// ─── A: names ────────────────────────────────────────────────────────────────

async function names(): Promise<void> {
  console.log("\nWS-NAME live names");
  const u = await makeUser("Test", "Person");
  const { c, id } = await startConversation(u, "name check");
  await db.collection("users").updateOne({ _id: u.id }, { $set: { firstName: "Shrirajj", lastName: "Naik" } });
  const admin = await adminConn();
  const init = await admin.adminInit;
  const row = (init?.conversations ?? []).find((r: any) => r.conversationId === id);
  check(
    "WS-NAME-01 a renamed customer shows by the live name (token still says 'Tokenname', stored copy 'Test')",
    row?.userName === "Shrirajj Naik" && row?.userFirstName === "Shrirajj" && row?.userLastName === "Naik",
    row
  );
  await db.collection("users").deleteOne({ _id: u.id });
  const adminAgain = await adminConn();
  const row2 = ((await adminAgain.adminInit)?.conversations ?? []).find((r: any) => r.conversationId === id);
  check("WS-NAME-01 a deleted record falls back to the stored copy", row2?.userFirstName === "Test" && row2?.userName === "Test", row2);

  // Agent renamed while connected: the next action uses the new name everywhere.
  await emitAck(admin.socket!, "support:assign", { conversationId: id });
  await db.collection("admins").updateOne({ _id: ADMIN_ID }, { $set: { firstName: "Admin Support", lastName: "" } });
  const status = nextEvent(c.socket!, "support:status", 4000);
  await emitAck(admin.socket!, "support:resolve", { conversationId: id });
  const doc = await chatsColl().findOne({ _id: new ObjectId(id) });
  check("WS-NAME-02 renamed agent, no reconnect: the resolve line says the new name", doc!.messages.some((m: any) => m.text === "This conversation was marked resolved by Admin Support"), doc!.messages.map((m: any) => m.text));
  check("WS-NAME-02 …and the customer's status event came", !!(await status));
  await emitAck(admin.socket!, "support:reopen", { conversationId: id });
  const reconnect = await customer(u);
  const j = await joinedOf(reconnect);
  check("WS-NAME-02 the customer sees the agent's FIRST name only", j?.assignedAdminName === "Admin Support", j);
  const second = await adminConn(admin2Token);
  const handover = await emitAck(second.socket!, "support:assign", { conversationId: id });
  const doc2 = await chatsColl().findOne({ _id: new ObjectId(id) });
  check("WS-NAME-02 handover names the previous agent live", handover?.ok && doc2!.messages.some((m: any) => /taking over from Admin Support/.test(m.text)), doc2!.messages.slice(-2).map((m: any) => m.text));

  // Emergency env admin: a users record, named from users.
  const envAdmin = await makeUser("Envy", "Operator");
  process.env.ADMIN_USER_IDS = String(envAdmin.id);
  const env = await connect({ token: envAdmin.token });
  await Promise.race([env.adminInit, sleep(4000)]);
  const w = await makeUser("Wes", "Env");
  const wc = await startConversation(w, "env admin");
  await emitAck(env.socket!, "support:assign", { conversationId: wc.id });
  const wdoc = await chatsColl().findOne({ _id: new ObjectId(wc.id) });
  process.env.ADMIN_USER_IDS = "";
  check("WS-NAME-03 an env-listed admin is named from their users record", wdoc!.messages.some((m: any) => m.text === "Envy joined the chat"), wdoc!.messages.map((m: any) => m.text));

  // Privacy: customer events carry no agent last name / e-mail.
  const customerEvents = JSON.stringify(reconnect.log.concat(c.log).map((e) => e.args));
  check("WS-PRIV-01 customer-facing events never carry agents' last names or e-mails", !/Team|Agent"|@verify\.local/.test(customerEvents));
}

// ─── A: inbox ────────────────────────────────────────────────────────────────

async function inbox(): Promise<void> {
  console.log("\nWS-INBOX paging, filtering, previews");
  // a pre-existing empty conversation enters with its first message
  const legacy = await makeUser("Lena", "Legacy");
  const now = new Date();
  const legacyId = new ObjectId();
  await chatsColl().insertMany([
    { _id: legacyId, userId: legacy.id, guestSessionId: null, userFirstName: "Lena", status: "pending", assignedAdminId: null, assignedAdminName: null, assignmentHistory: [], messages: [], rating: null, resolvedAt: null, ratingDismissedAt: null, createdAt: now, updatedAt: now, unreadCounts: { user: 0, admin: 0 } },
  ]);
  const admin = await adminConn();
  const init = await admin.adminInit;
  check("WS-INBOX-01 empty conversations are not listed", !(init?.conversations ?? []).some((r: any) => r.conversationId === String(legacyId)));
  const lc = await customer(legacy);
  const lj = await joinedOf(lc);
  const announced = nextEvent(admin.socket!, "support:new-conversation", 4000, (p) => p?.conversationId === String(legacyId));
  await emitAck(lc.socket!, "support:message", { conversationId: lj.conversationId, text: "finally writing", clientMessageId: "c_legacy_1" });
  check("WS-INBOX-01 a pre-existing empty conversation is joined and enters the inbox with its first message", lj?.conversationId === String(legacyId) && !!(await announced), lj);

  // 201+ unresolved + resolved: every conversation reachable by paging
  const bulk: any[] = [];
  const base = Date.now() - 10_000_000;
  for (let i = 0; i < 260; i++) {
    const t = new Date(base + Math.floor(i / 3) * 1000); // ties on updatedAt
    bulk.push({
      _id: new ObjectId(),
      userId: new ObjectId(),
      guestSessionId: null,
      userFirstName: `Bulk${i}`,
      status: i % 5 === 0 ? "resolved" : "open",
      assignedAdminId: null,
      assignedAdminName: null,
      assignmentHistory: [],
      messages: [
        { _id: new ObjectId(), from: "user", authorId: null, authorName: "You", text: `human ${i}`, createdAt: t, readBy: [] },
        ...Array.from({ length: 7 }, (_, k) => ({ _id: new ObjectId(), from: "system", authorId: null, authorName: null, text: `system ${k}`, createdAt: t, readBy: [], kind: "join" })),
      ],
      rating: null,
      resolvedAt: null,
      ratingDismissedAt: null,
      createdAt: t,
      updatedAt: t,
      unreadCounts: { user: 0, admin: 1 },
    });
  }
  await chatsColl().insertMany(bulk);
  const pager = await adminConn();
  const first = await pager.adminInit;
  const seen = new Set<string>((first?.conversations ?? []).map((r: any) => r.conversationId));
  let page = first;
  let pages = 1;
  let dupes = 0;
  while (page?.hasMore) {
    const last = page.conversations[page.conversations.length - 1];
    page = await emitAck(pager.socket!, "support:admin-more", { before: { updatedAt: new Date(last.updatedAt).toISOString(), id: last.conversationId } });
    pages++;
    for (const r of page?.conversations ?? []) {
      if (seen.has(r.conversationId)) dupes++;
      seen.add(r.conversationId);
    }
    if (pages > 20) break;
  }
  const humanTotal = await chatsColl().countDocuments({ "messages.from": { $in: ["user", "admin"] } });
  check("WS-INBOX-02 paging reaches every conversation with a human message exactly once (ties included)", seen.size === humanTotal && dupes === 0, { seen: seen.size, humanTotal, dupes, pages });
  const openTotal = await chatsColl().countDocuments({ status: { $in: ["pending", "open"] }, "messages.from": { $in: ["user", "admin"] } });
  check("WS-INBOX-02 the open count is exact (201+)", first?.openCount === openTotal && openTotal > 200, { openCount: first?.openCount, openTotal });
  const sample = await emitAck(pager.socket!, "support:admin-more", { before: { updatedAt: new Date(base + 60_000).toISOString(), id: "ffffffffffffffffffffffff" } });
  const bulkPreview = (sample?.conversations ?? []).find((r: any) => /^Bulk/.test(r.userFirstName));
  check("WS-INBOX-03 preview is the last human message even with 7 system lines after it", /^human \d+$/.test(bulkPreview?.lastMessage?.text ?? ""), bulkPreview?.lastMessage);

  const big = await makeUser("Bea", "Big");
  const bigId = new ObjectId();
  const msgs = Array.from({ length: 500 }, (_, i) => ({ _id: new ObjectId(), from: i % 2 ? "user" : "admin", authorId: null, authorName: null, text: `m${i} ${"x".repeat(300)}`, createdAt: new Date(), readBy: [] }));
  await chatsColl().insertMany([{ _id: bigId, userId: big.id, guestSessionId: null, userFirstName: "Bea", status: "open", assignedAdminId: null, assignedAdminName: null, assignmentHistory: [], messages: msgs, rating: null, resolvedAt: null, ratingDismissedAt: null, createdAt: new Date(), updatedAt: new Date(Date.now() + 60_000), unreadCounts: { user: 0, admin: 250 } }]);
  const bigAdmin = await adminConn();
  const bigRow = ((await bigAdmin.adminInit)?.conversations ?? []).find((r: any) => r.conversationId === String(bigId));
  check("WS-INBOX-03 a 500-message conversation: preview truncated to 160 characters", bigRow?.lastMessage?.text?.length === 160 && /^m499 /.test(bigRow.lastMessage.text), bigRow?.lastMessage?.text?.length);
  const size = JSON.stringify((await bigAdmin.adminInit)?.conversations ?? []).length;
  check("PF-01 a 50-row inbox page stays small (≤ 40 KB uncompressed)", size <= 40_000, size);
}

// ─── A: commit order, read receipts ──────────────────────────────────────────

async function ordering(): Promise<void> {
  console.log("\nWS-ORDER-02 / WS-READ / WS-STATUS commit order");
  const admin = await adminConn();
  const u = await makeUser("Oda", "Order");
  const tabA = await customer(u);
  const tabB = await customer(u);
  await Promise.all([joinedOf(tabA), joinedOf(tabB)]);
  const firstAck = await emitAck(tabA.socket!, "support:message", { conversationId: null, text: "one", clientMessageId: "c_ord_0" });
  const id = firstAck.conversationId;
  await emitAck(admin.socket!, "support:assign", { conversationId: id });
  const g = gate();
  let paused = false;
  hook({
    method: "findOneAndUpdate",
    collection: "support_chats",
    match: (args) => args[0]?.["messages.clientMessageId"]?.$ne === "c_ord_A",
    before: async () => {
      paused = true;
      await g.wait;
    },
  });
  const updates: any[] = [];
  admin.socket!.on("support:conversation-updated", (p: any) => p?.conversationId === id && updates.push(p));
  const aPromise = emitAck(tabA.socket!, "support:message", { conversationId: id, text: "A stalls", clientMessageId: "c_ord_A" });
  await until(() => paused);
  await emitAck(tabB.socket!, "support:message", { conversationId: id, text: "B commits first", clientMessageId: "c_ord_B" });
  g.open();
  await aPromise;
  clearHooks();
  await sleep(300);
  const doc = await chatsColl().findOne({ _id: new ObjectId(id) });
  const a = doc!.messages.find((m: any) => m.clientMessageId === "c_ord_A");
  const b = doc!.messages.find((m: any) => m.clientMessageId === "c_ord_B");
  const revs = updates.map((p) => p.rev);
  check("WS-ORDER-02 commit order: B's seq < A's seq although A was created first", b.seq < a.seq && a.createdAt < b.createdAt, { a: a.seq, b: b.seq });
  check("WS-ORDER-02 unread is exact (3 customer messages, agent read none)", doc?.unreadCounts?.admin === 3 && doc?.userMsgs === 3, doc?.unreadCounts);
  check("WS-ORDER-02 events carry increasing revisions", revs.every((r, i) => i === 0 || r > revs[i - 1]), revs);

  // read receipts
  const mB = { seq: b.seq, messageId: String(b._id) };
  admin.socket!.emit("support:read", { conversationId: id, ...mB });
  await sleep(300);
  let d = await chatsColl().findOne({ _id: new ObjectId(id) });
  check("WS-READ-01 reading up to B leaves A (committed after B) unread", d?.unreadCounts?.admin === 1, d?.unreadCounts);
  const older = doc!.messages.find((m: any) => m.clientMessageId === "c_ord_0");
  admin.socket!.emit("support:read", { conversationId: id, seq: older.seq, messageId: String(older._id) });
  await sleep(300);
  d = await chatsColl().findOne({ _id: new ObjectId(id) });
  check("WS-READ-02 a late, older receipt can't bring unread back", d?.unreadCounts?.admin === 1, d?.unreadCounts);
  const other = await makeUser("Fox", "Foreign");
  const oc = await startConversation(other, "foreign");
  const odoc = await chatsColl().findOne({ _id: new ObjectId(oc.id) });
  const foreignMsg = odoc!.messages[0];
  admin.socket!.emit("support:read", { conversationId: id, seq: foreignMsg.seq, messageId: String(foreignMsg._id) });
  admin.socket!.emit("support:read", { conversationId: id, seq: 999999, messageId: String(a._id) });
  await sleep(300);
  d = await chatsColl().findOne({ _id: new ObjectId(id) });
  check("WS-READ-03 foreign or future ids change nothing", d?.unreadCounts?.admin === 1, d?.unreadCounts);
  admin.socket!.emit("support:read", { conversationId: id, seq: a.seq, messageId: String(a._id) });
  await sleep(300);
  d = await chatsColl().findOne({ _id: new ObjectId(id) });
  check("WS-READ-01 reading up to A clears it", d?.unreadCounts?.admin === 0, d?.unreadCounts);

  // > 500 unread
  const many = await makeUser("Mani", "Many");
  const mc = await startConversation(many, "start");
  const agentMany = await adminConn(admin2Token);
  await emitAck(agentMany.socket!, "support:assign", { conversationId: mc.id });
  await chatsColl().updateOne({ _id: new ObjectId(mc.id) }, { $set: { userMsgs: 700, "readUserIdx.admin": 0, "unreadCounts.admin": 700 } });
  const last = await emitAck(mc.c.socket!, "support:message", { conversationId: mc.id, text: "701st", clientMessageId: "c_many_1" });
  let md = await chatsColl().findOne({ _id: new ObjectId(mc.id) });
  check("WS-READ-04 unread counts past 500 messages (counter, not the ring)", md?.unreadCounts?.admin === 701, md?.unreadCounts);
  const lastMsg = md!.messages.find((m: any) => String(m._id) === last.messageId);
  agentMany.socket!.emit("support:read", { conversationId: mc.id, seq: lastMsg.seq, messageId: last.messageId });
  await sleep(300);
  md = await chatsColl().findOne({ _id: new ObjectId(mc.id) });
  check("WS-READ-04 …and reading the latest clears all of them", md?.unreadCounts?.admin === 0, md?.unreadCounts);

  // status revisions keep order across resolve → reopen
  const statusRevs: any[] = [];
  admin.socket!.on("support:conversation-updated", (p: any) => p?.conversationId === id && p?.status && statusRevs.push({ status: p.status, rev: p.rev }));
  await emitAck(admin.socket!, "support:resolve", { conversationId: id });
  await emitAck(admin.socket!, "support:reopen", { conversationId: id });
  await sleep(200);
  const rs = statusRevs.filter((s) => s.status === "resolved").pop();
  const ro = statusRevs.filter((s) => s.status === "open").pop();
  check("WS-STATUS-01 a delayed resolve event is recognisably older than the reopen", !!rs && !!ro && ro.rev > rs.rev, statusRevs);
}

// ─── A: expiry, revocation, timeouts, resources, archive ─────────────────────

async function lifetime(): Promise<void> {
  console.log("\nWS-SEC-05 token expiry and agent revocation");
  const u = await makeUser("Exp", "Iry");
  const short = token({ userId: String(u.id), firstName: "Exp", tokenVersion: 0, admin: 0 }, 2);
  const c = await connect({ token: short, guestSessionId: "g_exp_dev", proto: 2 });
  const gone = await until(() => c.socket!.disconnected, 5000);
  check("WS-SEC-05 a socket is disconnected when its token expires", gone);

  const revokedId = new ObjectId();
  await db.collection("admins").insertMany([{ _id: revokedId, firstName: "Revo", lastName: "Ked", role: "admin", status: { active: true, banned: false } }]);
  const rtoken = token({ userId: String(revokedId), firstName: "Revo" });
  const agent = await adminConn(rtoken);
  const x = await makeUser("Xan", "Revoke");
  const xc = await startConversation(x);
  await db.collection("admins").updateOne({ _id: revokedId }, { $set: { "status.banned": true } });
  const r = await emitAck(agent.socket!, "support:assign", { conversationId: xc.id });
  const dropped = await until(() => agent.socket!.disconnected, 2000);
  check("WS-SEC-05 a banned agent is refused on the next action and disconnected", r?.ok === false && /revoked/.test(r?.error ?? "") && dropped, { r, dropped });
}

async function timeouts(): Promise<void> {
  console.log("\nWS-TIME / WS-RES bounded waiting, no overlap");
  const { withKeyLock, keyLockCount, createSerialQueue } = await import("../src/lib/rateLimit");
  // unit: a waiter that gets no turn gives up without running; order kept
  const order: string[] = [];
  const g = gate();
  const holder = withKeyLock("unit", async () => {
    order.push("holder-start");
    await g.wait;
    order.push("holder-end");
  });
  const waiter = withKeyLock("unit", async () => order.push("waiter-ran"), 100).catch((e) => order.push(`waiter-${(e as Error).message.split(" ")[0]}`));
  const next = withKeyLock("unit", async () => order.push("next-ran"), 5000);
  await sleep(250);
  g.open();
  await Promise.all([holder, waiter, next]);
  check("WS-TIME-01 lock: a timed-out waiter never runs, the holder isn't cut short, later waiters keep order", JSON.stringify(order) === JSON.stringify(["holder-start", "waiter-busy", "holder-end", "next-ran"]), order);
  check("WS-TIME-01 lock map drains to 0", keyLockCount() === 0, keyLockCount());

  const q = createSerialQueue(2, 100);
  const qg = gate();
  const runs: string[] = [];
  const q1 = q.run(async () => {
    runs.push("1");
    await qg.wait;
  });
  const q2 = q.run(async () => runs.push("2")).catch((e) => runs.push(`2-${(e as Error).message.split(" ")[0]}`));
  const q3 = q.run(async () => runs.push("3")).catch((e) => runs.push(`3-${(e as Error).message.split(" ")[0]}`));
  await sleep(250);
  qg.open();
  await Promise.all([q1, q2, q3]);
  check("WS-RES-01 queue: bounded (3rd refused) and a task that waited too long never runs", runs.includes("3-too") && runs.includes("2-request") && !runs.includes("2") && q.pending === 0, runs);

  // integration: a stalled creation holds the lock; a second tab gives up, no second doc
  const u = await makeUser("Sal", "Stall");
  const sg = gate();
  let stalled = false;
  hook({
    method: "insertOne",
    collection: "support_chats",
    match: (args) => args[0]?.activeKey === `u:${u.id}`,
    before: async () => {
      stalled = true;
      await sg.wait;
    },
  });
  const a = await customer(u);
  const b = await customer(u);
  await Promise.all([joinedOf(a), joinedOf(b)]);
  const first = emitAck(a.socket!, "support:message", { conversationId: null, text: "stalled create", clientMessageId: "c_stall_a" }, 20_000);
  await until(() => stalled);
  const second = await emitAck(b.socket!, "support:message", { conversationId: null, text: "second tab", clientMessageId: "c_stall_b" }, 20_000);
  sg.open();
  const firstResult = await first;
  clearHooks();
  const docs = await chatsColl().countDocuments({ userId: u.id });
  check("WS-TIME-01 a waiter behind a stalled holder gives up ('busy') and never overlaps it", second?.ok === false && /busy/.test(second?.error ?? "") && firstResult?.ok === true && docs === 1, { second, firstResult, docs });
  check("WS-TIME-01 no lock left behind", keyLockCount() === 0, keyLockCount());

  // typing is rate-limited per socket and needs the room
  const t = await makeUser("Ty", "Ping");
  const tc = await startConversation(t);
  const agent = await adminConn();
  await emitAck(agent.socket!, "support:assign", { conversationId: tc.id });
  let seen = 0;
  agent.socket!.on("support:typing", (p: any) => p?.conversationId === tc.id && seen++);
  for (let i = 0; i < 50; i++) tc.c.socket!.emit("support:typing", { conversationId: tc.id, isTyping: i % 2 === 0 });
  await sleep(600);
  check("WS-RES-01 typing spam is capped (≤ 10 per 10 s per socket)", seen > 0 && seen <= 10, seen);
}

async function archiveFailure(): Promise<void> {
  console.log("\nWS-ARCH-01 archive failure");
  const u = await makeUser("Arch", "Ive");
  const c = await customer(u);
  await joinedOf(c);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  hook({
    method: "insertOne",
    collection: "support_chats_archive",
    match: (args) => args[0]?.message?.text === "archive will fail",
    fail: () => new Error("simulated archive outage"),
    times: 3,
  });
  const ack = await emitAck(c.socket!, "support:message", { conversationId: null, text: "archive will fail", clientMessageId: "c_arch_1" });
  clearHooks();
  console.error = original;
  const doc = await chatsColl().findOne({ _id: new ObjectId(ack.conversationId) });
  check("WS-ARCH-01 archive failures are logged loudly and the message stays in the ring", ack?.ok === true && doc!.messages.some((m: any) => m.text === "archive will fail") && errors.some((e) => /archive insert FAILED/.test(e)), { ack, errors: errors.slice(0, 2) });
}

async function compatLegacy(): Promise<void> {
  console.log("\nCP-01 an older widget bundle (no proto) still works");
  const u = await makeUser("Olga", "Oldbundle");
  const admin = await adminConn();
  const c = await connect({ token: u.token, guestSessionId: "g_old_bundle" });
  const j = await joinedOf(c);
  const doc = j?.conversationId ? await chatsColl().findOne({ _id: new ObjectId(j.conversationId) }) : null;
  check("CP-01 old bundle gets a conversation on open (marked legacy-open)", !!doc && doc.createdBy === "legacy-open", j);
  check("CP-01 …which is not announced to agents on open", !admin.log.some((e) => e.event === "support:new-conversation" && e.args[0]?.conversationId === j?.conversationId));
  const init = await (await adminConn()).adminInit;
  check("CP-01 …nor listed in the inbox while empty", !(init?.conversations ?? []).some((r: any) => r.conversationId === j?.conversationId));
  const announced = nextEvent(admin.socket!, "support:new-conversation", 4000, (p) => p?.conversationId === j?.conversationId);
  const s = await emitAck(c.socket!, "support:message", { conversationId: j.conversationId, text: "old bundle speaks" });
  check("CP-01 its first message announces it", s?.ok === true && !!(await announced), s);
  // the legacy double start (connect + support:start) never creates two
  const v = await makeUser("Dup", "Start");
  for (let i = 0; i < 5; i++) {
    const cc = await connect({ token: v.token, guestSessionId: "g_dup_start" });
    cc.socket!.emit("support:start", {});
    await joinedOf(cc);
  }
  check("CP-01 legacy connect + start, 5 reconnects: one conversation", (await chatsColl().countDocuments({ userId: v.id })) === 1);
  // polling transport ordering
  const p = await makeUser("Polly", "Polling");
  const pc = await connect({ token: p.token, guestSessionId: "g_polling", proto: 2 }, { transports: ["polling"] });
  await joinedOf(pc);
  const seq: string[] = [];
  pc.socket!.onAny((e) => seq.push(e));
  const pa = await emitAck(pc.socket!, "support:message", { conversationId: null, text: "over polling", clientMessageId: "c_poll_1" });
  seq.push("ack");
  await sleep(300);
  check("WS-ORDER-01 same order over the polling transport", pa?.ok === true && seq.indexOf("support:started") < seq.indexOf("support:message") && seq.indexOf("support:message") < seq.lastIndexOf("ack"), seq);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mongo = new MongoClient(DB_URI);
  await mongo.connect();
  db = mongo.db(DB_NAME);
  installHookPlumbing();

  const { mountSupportNamespace } = await import("../src/lib/supportSocket");
  const server: HttpServer = createServer();
  const io = new IOServer(server, { cors: { origin: true } });
  mountSupportNamespace(io);
  // crash simulation: make one broadcast of an event throw after the commit
  const proto = Object.getPrototypeOf(io.of("/support").to("probe"));
  const originalEmit = proto.emit;
  proto.emit = function (this: unknown, event: string, ...args: unknown[]) {
    if (broadcastFailure && broadcastFailure.event === event && broadcastFailure.remaining > 0) {
      broadcastFailure.remaining--;
      throw new Error("simulated crash before the event");
    }
    return originalEmit.call(this, event, ...args);
  };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`verify-support-socket: ${url}, database ${DB_NAME}`);

  const groups: [string, () => Promise<void>][] = [
    ["sec", a0Security],
    ["sec-malformed", a0Malformed],
    ["sec-owner", a0Ownership],
    ["sec-identity", a0Identity],
    ["life-draft", lifeDraft],
    ["life-race", lifeRace],
    ["life-multi", lifeMultiProcess],
    ["life-tabs", lifeDraftTabs],
    ["life-starts", lifeStarts],
    ["life-crash", lifeCrash],
    ["idem", idempotency],
    ["race", races],
    ["claim", claims],
    ["names", names],
    ["inbox", inbox],
    ["order", ordering],
    ["lifetime", lifetime],
    ["time", timeouts],
    ["archive", archiveFailure],
    ["compat", compatLegacy],
  ];
  try {
    await seedAdmins();
    for (const [name, run] of groups) {
      if (ONLY && !name.startsWith(ONLY)) continue;
      try {
        await run();
      } catch (err) {
        check(`${name}: group completed without throwing`, false, String((err as Error)?.stack ?? err));
      } finally {
        clearHooks();
        broadcastFailure = null;
        for (const s of sockets.splice(0)) s.disconnect();
        await sleep(150);
      }
    }
  } finally {
    io.close();
    server.close();
    await db.dropDatabase().catch(() => {});
    await mongo.close();
  }

  check("no unhandled rejections anywhere", unhandled.length === 0, unhandled.slice(0, 5));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (process.env.SUPPORT_VERIFY_EVIDENCE) {
    const { writeFileSync } = await import("fs");
    writeFileSync(process.env.SUPPORT_VERIFY_EVIDENCE, JSON.stringify({ at: new Date().toISOString(), database: DB_NAME, results }, null, 2));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
