// Simple in-memory sliding-window rate limiter, sized for a single Railway container.
// Resets on process restart — acceptable for the use case (we're protecting against
// runaway clients, not committed adversaries).

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Periodic cleanup so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets.entries()) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref?.();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * @param key - identifier (IP, JWT subject, guestSessionId)
 * @param limit - max calls per window
 * @param windowMs - rolling window in ms
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
  }
  if (b.count >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: b.resetAt - now };
  }
  b.count += 1;
  return { ok: true, remaining: limit - b.count, retryAfterMs: 0 };
}

export function ipFromHeaders(headers: Headers): string {
  // X-Forwarded-For first IP wins; fall back to a synthetic key.
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

// Concurrency lock for global one-at-a-time operations (e.g., bulk re-index).
const locks = new Set<string>();

export function tryAcquireLock(name: string): boolean {
  if (locks.has(name)) return false;
  locks.add(name);
  return true;
}

export function releaseLock(name: string): void {
  locks.delete(name);
}
