import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import clientPromise from "./mongodb";

export interface AppJwtPayload {
  id?: string;
  userId?: string;
  email?: string;
  role?: string;
  // server.me's loginController.js stamps `admin: 1` for admin role logins, `admin: 0` otherwise.
  admin?: number;
  [key: string]: unknown;
}

/**
 * Verify a JWT against the shared JWT_SECRET. Returns null on invalid/expired tokens.
 * The same secret as server.me is used so users logged in on majesticescape.in
 * are trusted by this service without a separate auth flow.
 */
export function verifyToken(token: string | null | undefined): AppJwtPayload | null {
  if (!token) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("[jwt] JWT_SECRET not set — refusing to verify tokens");
    return null;
  }
  try {
    const payload = jwt.verify(token, secret);
    if (typeof payload === "string") return null;
    return payload as AppJwtPayload;
  } catch (err) {
    console.warn("[jwt] verify failed:", (err as Error).message);
    return null;
  }
}

function extractUserId(payload: AppJwtPayload): string {
  if (typeof payload.userId === "string") return payload.userId.trim();
  if (typeof payload.id === "string") return payload.id.trim();
  return "";
}

// Synchronous JWT-and-env-var-only admin check. Used internally by `resolveIsAdmin`
// and exported for the rare caller that genuinely cannot await (none today).
// Prefer `resolveIsAdmin` for any new code — it also consults the database.
export function isAdminPayload(payload: AppJwtPayload | null): boolean {
  if (!payload) return false;
  if (payload.role === "admin") return true;
  if (typeof payload.admin === "number" && payload.admin === 1) return true;

  const userId = extractUserId(payload);
  const adminIds = (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (userId && adminIds.includes(userId)) return true;

  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (email && adminEmails.includes(email)) return true;

  return false;
}

// In-memory cache to avoid hitting the DB on every socket message / admin request.
// Admin status changes infrequently (a person becomes/stops being an admin maybe a
// few times per quarter at most), so a 5-minute TTL is a comfortable trade-off
// between DB load and how quickly a freshly-banned admin loses access.
const ADMIN_CACHE_TTL_MS = 5 * 60 * 1000;
const adminCache = new Map<string, { isAdmin: boolean; expires: number }>();

async function isAdminInDb(userId: string): Promise<boolean> {
  if (!userId) return false;
  if (!ObjectId.isValid(userId)) return false;

  const cached = adminCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.isAdmin;

  try {
    const client = await clientPromise;
    const db = client.db();
    // Match `server.me/models/Admin.js`: collection "admins", role enum includes
    // "admin", banned admins lose access. We use a single findOne with a
    // projection — fast, indexed by _id.
    const found = await db.collection("admins").findOne(
      {
        _id: new ObjectId(userId),
        role: "admin",
        "status.banned": { $ne: true },
      },
      { projection: { _id: 1 } }
    );
    const isAdmin = !!found;
    adminCache.set(userId, { isAdmin, expires: Date.now() + ADMIN_CACHE_TTL_MS });
    return isAdmin;
  } catch (err) {
    // Network blip / DB outage: deny admin rather than fail-open. The user
    // can still chat as a regular user; admin actions just won't authorize
    // until DB is reachable again.
    console.warn("[jwt] DB admin lookup failed for", userId, "—", (err as Error).message);
    return false;
  }
}

// Treat a JWT identity as admin if any of the following match (in order):
//   1. canonical `role: "admin"` JWT claim
//   2. server.me legacy `admin: 1` JWT claim
//   3. `userId` is in ADMIN_USER_IDS env (emergency override)
//   4. `email` is in ADMIN_EMAILS env (emergency override)
//   5. `userId` resolves to a non-banned `role: "admin"` record in the `admins`
//      collection (the canonical source of truth — populated by admin.site's
//      signup flow via server.me's adminController)
//
// In production with no env vars set, path 5 is what fires — admin.site's
// adminController signs JWTs containing only { userId, firstName }, no email
// or role claim, so paths 1, 2, and 4 never match for those tokens.
export async function resolveIsAdmin(payload: AppJwtPayload | null): Promise<boolean> {
  if (!payload) return false;
  if (isAdminPayload(payload)) return true;
  const userId = extractUserId(payload);
  if (!userId) return false;
  return isAdminInDb(userId);
}
