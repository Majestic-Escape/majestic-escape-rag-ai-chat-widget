import type { Db, ObjectId } from "mongodb";

// Display names for support chat, read from the people's own records.
//
// server.me owns the names: `users` for customers (an admin can rename them
// from the Users grid) and `admins` for agents (renamed from Settings). The
// JWT `firstName` claim is only what was true at sign-in and lives 7 days,
// and the names stored on a conversation are only what was true when they
// were written — so neither is used when a record can be read. The stored
// copies stay as the fallback for a record that no longer exists.
//
// No environment reads at module scope (see CLAUDE.md, precompiled server):
// callers pass the Db.

export interface PersonName {
  first: string;
  last: string;
  full: string;
}

const LOOKUP_MAX_TIME_MS = 2000;

// Trim, drop control and format characters, collapse whitespace, cap.
export function cleanName(value: unknown, max = 60): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || null;
}

export function personName(doc: Record<string, unknown> | null | undefined): PersonName | null {
  const first = cleanName(doc?.firstName);
  if (!first) return null;
  const last = cleanName(doc?.lastName) ?? "";
  return { first, last, full: cleanName(last ? `${first} ${last}` : first, 120) ?? first };
}

async function namesFrom(db: Db, collection: "users" | "admins", ids: ObjectId[]): Promise<Map<string, PersonName>> {
  const out = new Map<string, PersonName>();
  const unique = [...new Map(ids.filter(Boolean).map((id) => [String(id), id])).values()];
  if (!unique.length) return out;
  const docs = await db
    .collection(collection)
    .find({ _id: { $in: unique } }, { projection: { firstName: 1, lastName: 1 }, maxTimeMS: LOOKUP_MAX_TIME_MS })
    .toArray();
  for (const doc of docs) {
    const name = personName(doc);
    if (name) out.set(String(doc._id), name);
  }
  return out;
}

export function lookupUserNames(db: Db, ids: ObjectId[]): Promise<Map<string, PersonName>> {
  return namesFrom(db, "users", ids);
}

// Agents live in `admins`; the emergency ADMIN_USER_IDS / role-admin accounts
// are `users` records, so those are looked up there when `admins` has none.
export async function lookupAdminNames(db: Db, ids: ObjectId[]): Promise<Map<string, PersonName>> {
  const names = await namesFrom(db, "admins", ids);
  const missing = ids.filter((id) => id && !names.has(String(id)));
  if (missing.length) {
    for (const [id, name] of await namesFrom(db, "users", missing)) names.set(id, name);
  }
  return names;
}

// The acting agent's current record: name, and whether an `admins` record
// still allows it (banned, deactivated or demoted → false). `known` is false
// when there is no `admins` record at all (an env / role admin), in which
// case the caller keeps its handshake decision.
export async function adminStanding(
  db: Db,
  id: ObjectId
): Promise<{ known: boolean; allowed: boolean; name: PersonName | null }> {
  const admin = await db
    .collection("admins")
    .findOne({ _id: id }, { projection: { firstName: 1, lastName: 1, role: 1, status: 1 }, maxTimeMS: LOOKUP_MAX_TIME_MS });
  if (admin) {
    const status = (admin.status ?? {}) as { banned?: boolean; active?: boolean };
    const allowed = (!admin.role || admin.role === "admin") && status.banned !== true && status.active !== false;
    return { known: true, allowed, name: personName(admin) };
  }
  const user = await db
    .collection("users")
    .findOne({ _id: id }, { projection: { firstName: 1, lastName: 1 }, maxTimeMS: LOOKUP_MAX_TIME_MS });
  return { known: false, allowed: true, name: personName(user) };
}
