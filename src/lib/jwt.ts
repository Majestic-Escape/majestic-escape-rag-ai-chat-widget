import jwt from "jsonwebtoken";

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

// Treat a JWT identity as admin if any of the following match:
//   1. canonical `role: "admin"` claim
//   2. server.me legacy `admin: 1` claim
//   3. `userId` is in ADMIN_USER_IDS env (when admin.site's login doesn't stamp the claim)
//   4. `email` is in ADMIN_EMAILS env (covers future signing schemes that include email)
export function isAdminPayload(payload: AppJwtPayload | null): boolean {
  if (!payload) return false;
  if (payload.role === "admin") return true;
  if (typeof payload.admin === "number" && payload.admin === 1) return true;

  const userId =
    typeof payload.userId === "string"
      ? payload.userId.trim()
      : typeof payload.id === "string"
      ? payload.id.trim()
      : "";
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
