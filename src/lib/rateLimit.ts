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

// ─── Keyed mutex ─────────────────────────────────────────────────────────────
//
// Runs `fn` alone for its key, in arrival order, on this process (the support
// server is one Railway instance; anything that must hold across instances
// is enforced in the database instead). The lock is released only when
// `fn` settles — never on a timer — because a timed-out promise does not stop
// its database work, and releasing early would let the next holder overlap
// it. Waiting is bounded: a waiter that gets no turn within `waitMs` gives up
// with "busy" without ever running, and its place in the chain opens as soon
// as the holder before it finishes, so later waiters keep their order.
const keyLocks = new Map<string, Promise<void>>();

export function withKeyLock<T>(key: string, fn: () => Promise<T>, waitMs = 10_000): Promise<T> {
  const previous = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => done);
  keyLocks.set(key, tail);
  void tail.then(() => {
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const turn = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
    void previous.then(() => resolve(true));
  });
  return turn.then(async (mine) => {
    if (timer) clearTimeout(timer);
    if (!mine) {
      void previous.then(release);
      throw new Error("busy — try again in a moment");
    }
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

// Number of keys currently locked or waited on (tests assert it drains to 0).
export function keyLockCount(): number {
  return keyLocks.size;
}

// ─── Serial queue ────────────────────────────────────────────────────────────
//
// One per socket: its lifecycle events (join, start, message, admin actions)
// run one at a time in arrival order, so a join can never interleave with the
// same socket's first message. Bounded: more than `max` waiting tasks are
// refused, and a task that waited longer than `expireMs` is dropped without
// running (it never started, so nothing overlaps).
export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly pending: number;
}

export function createSerialQueue(max = 32, expireMs = 15_000): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    run<T>(task: () => Promise<T>): Promise<T> {
      if (pending >= max) return Promise.reject(new Error("too many requests at once — try again"));
      pending++;
      const queuedAt = Date.now();
      const result = tail.then(() => {
        if (Date.now() - queuedAt > expireMs) throw new Error("request expired — try again");
        return task();
      });
      tail = result.then(
        () => {
          pending--;
        },
        () => {
          pending--;
        }
      );
      return result;
    },
  };
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
