// Phase 0 cost-audit instrumentation.
//
// Railway bills this service ~88% for memory, and we do not yet know what holds
// it. `process.memoryUsage()` alone can't tell us: RSS is the number Railway
// charges for, but it is the sum of V8 heap, native allocations, buffers and the
// binary's own text/data pages. A precompiled server and a `tsx` server differ
// mostly in the *last* of those, so we need the split, not the total.
//
// Everything here is read-only observation. The Mongo pool counters are plain
// integer increments on events the driver already emits (CMAP monitoring is on
// by default in the Node driver — unlike command monitoring, it needs no opt-in),
// and every listener body is wrapped so a bug in accounting can never take down a
// request path.
//
// TEMPORARY: remove this module and its route after Phase 2 concludes. It exists
// to make one decision — precompile or not — and heap/topology detail is
// fingerprinting material we shouldn't carry in production indefinitely.

import type { EventEmitter } from "events";
import { monitorEventLoopDelay, type IntervalHistogram } from "perf_hooks";
import v8 from "v8";

// ── Why every piece of state below lives on `globalThis` ────────────
//
// This module exists twice in one process. `server.ts` is loaded by tsx and
// pulls in `src/workers/**` → `src/lib/mongodb.ts` directly; Next.js separately
// bundles the route handlers, which import `@/lib/mongodb` through its own
// module graph. Two instances, two sets of module-level variables — and the same
// pattern `src/lib/mongodb.ts` already works around with
// `global._mongoClientPromise`.
//
// The first version of this file used plain module-level state and the
// consequences were visible in the very first reading: process uptime 77s but
// pool "observed for" 0.16s, zero `connectionCreated` events, and a
// `checkedOutNow` that disagreed with its own totals. The worker instance
// created and instrumented the client at boot; the route instance answered from
// a second, empty counter object it had attached to an already-connected client
// moments earlier. Every number was real and every number was wrong.
//
// Sharing through `globalThis` makes the boot-time instrumentation the thing the
// route actually reports.

interface PoolMetrics {
  attached: boolean;
  since: number | null;
  checkedOutNow: number;
  checkedOutPeak: number;
  connectionsOpenNow: number;
  connectionsOpenPeak: number;
  totals: Record<string, number>;
  checkOutWaitMsMax: number;
  checkOutWaitMsTotal: number;
  checkOutWaitSamples: number;
}

interface MetricsState {
  pool: PoolMetrics;
  loopDelay: IntervalHistogram | null;
  loopDelaySince: number;
}

declare global {
  // eslint-disable-next-line no-var
  var _processMetricsState: MetricsState | undefined;
}

const state: MetricsState = (global._processMetricsState ??= {
  pool: {
    attached: false,
    since: null,
    checkedOutNow: 0,
    checkedOutPeak: 0,
    connectionsOpenNow: 0,
    connectionsOpenPeak: 0,
    totals: Object.create(null),
    checkOutWaitMsMax: 0,
    checkOutWaitMsTotal: 0,
    checkOutWaitSamples: 0,
  },
  loopDelay: null,
  loopDelaySince: 0,
});

const pool = state.pool;

// ── Event-loop delay ────────────────────────────────────────────────
//
// Enabled lazily on the first diagnostics read rather than at module load.
// `monitorEventLoopDelay` installs a libuv timer, and this module is reachable
// from `src/lib/mongodb.ts`, which short-lived scripts (`npm run
// verify:ai-toggle`) import — enabling at import time risks holding their event
// loop open and hanging a script that should exit. Nothing here is worth that.

function ensureLoopDelay(): IntervalHistogram {
  if (!state.loopDelay) {
    state.loopDelay = monitorEventLoopDelay({ resolution: 20 });
    state.loopDelay.enable();
    state.loopDelaySince = Date.now();
  }
  return state.loopDelay;
}

// ── Mongo connection pool ───────────────────────────────────────────
//
// `maxPoolSize` defaults to 100 and `minPoolSize` to 0, so the interesting
// number is not the ceiling but the *peak concurrent checkouts* actually
// reached. Phase 1 sets the guardrail from this measurement; without it we'd be
// picking a number out of the air.

function bump(name: string): void {
  pool.totals[name] = (pool.totals[name] ?? 0) + 1;
}

/**
 * Attach CMAP listeners to the shared MongoClient. Idempotent — the client is a
 * process-wide singleton, and attaching twice would double every count.
 *
 * Deliberately takes the client as an argument instead of importing
 * `./mongodb`: that module calls this one, and an import back would be a cycle.
 */
export function attachPoolMetrics(client: EventEmitter): void {
  if (pool.attached) return;
  pool.attached = true;
  pool.since = Date.now();

  const on = (event: string, fn: (ev: unknown) => void) => {
    client.on(event, (ev: unknown) => {
      // Accounting must never be able to break the connection pool. An
      // exception thrown from a listener on an EventEmitter with no error
      // handler would be fatal to the process.
      try {
        fn(ev);
      } catch {
        /* observation only */
      }
    });
  };

  on("connectionCheckOutStarted", () => bump("checkOutStarted"));

  on("connectionCheckedOut", (ev) => {
    bump("checkedOut");
    pool.checkedOutNow += 1;
    if (pool.checkedOutNow > pool.checkedOutPeak) {
      pool.checkedOutPeak = pool.checkedOutNow;
    }
    // Driver 6 reports this as `durationMS`; older shapes used `duration`.
    // Read both rather than assume, since a wrong field silently reports 0 wait
    // and would make a saturated pool look healthy.
    const record = ev as { durationMS?: unknown; duration?: unknown };
    const waited =
      typeof record.durationMS === "number"
        ? record.durationMS
        : typeof record.duration === "number"
          ? record.duration
          : null;
    if (waited !== null && Number.isFinite(waited)) {
      pool.checkOutWaitSamples += 1;
      pool.checkOutWaitMsTotal += waited;
      if (waited > pool.checkOutWaitMsMax) pool.checkOutWaitMsMax = waited;
    }
  });

  on("connectionCheckedIn", () => {
    bump("checkedIn");
    // Clamp at zero: if listeners attach mid-flight, a check-in can arrive for a
    // checkout we never saw, and a negative "in use" count reads as nonsense.
    if (pool.checkedOutNow > 0) pool.checkedOutNow -= 1;
  });

  on("connectionCheckOutFailed", () => bump("checkOutFailed"));

  on("connectionCreated", () => {
    bump("connectionCreated");
    pool.connectionsOpenNow += 1;
    if (pool.connectionsOpenNow > pool.connectionsOpenPeak) {
      pool.connectionsOpenPeak = pool.connectionsOpenNow;
    }
  });

  on("connectionClosed", () => {
    bump("connectionClosed");
    if (pool.connectionsOpenNow > 0) pool.connectionsOpenNow -= 1;
  });

  on("connectionPoolCreated", () => bump("poolCreated"));
  on("connectionPoolReady", () => bump("poolReady"));
  on("connectionPoolCleared", () => bump("poolCleared"));
  on("connectionPoolClosed", () => bump("poolClosed"));
}

// ── Snapshot ────────────────────────────────────────────────────────

const round = (n: number, dp = 2) => Number(n.toFixed(dp));
const mb = (bytes: number) => round(bytes / 1024 / 1024);

export interface ProcessMetricsSnapshot {
  timestamp: string;
  uptimeSec: number;
  runtime: {
    node: string;
    // The A/B in Phase 2 is "tsx vs precompiled". Recording which one produced a
    // sample removes any doubt later about which deploy a number came from.
    transpilingAtRuntime: boolean;
    execArgv: string[];
    nodeEnv: string | undefined;
    maxOldSpaceMb: number;
    constrainedMemoryMb: number | null;
  };
  memoryMb: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
    // RSS minus the V8 heap reservation. This is the figure the Phase 2 A/B
    // turns on: loaded module code, native allocations and the TypeScript
    // compiler if one is resident.
    //
    // Deliberately NOT `rss - (heapTotal + external)`. The first reading here
    // was rss 434 MB with external 725 MB and arrayBuffers 686 MB — `external`
    // counts memory V8 knows about but that need not be resident, so subtracting
    // it produced a residue that clamped to zero and would have quietly hidden
    // the very thing we are trying to measure.
    rssMinusHeapTotal: number;
    peakRss: number;
  };
  heap: {
    totalHeapSizeMb: number;
    usedHeapSizeMb: number;
    heapSizeLimitMb: number;
    mallocedMemoryMb: number;
    externalMemoryMb: number;
    numberOfNativeContexts: number;
    numberOfDetachedContexts: number;
  };
  cpu: {
    userSec: number;
    systemSec: number;
    // Cumulative CPU over cumulative wall-clock. Railway bills vCPU-minutes, so
    // this is directly comparable to the number on the invoice.
    avgCoresSinceBoot: number;
  };
  // Null until the histogram has recorded at least one sample. An empty
  // `IntervalHistogram` reports `min` as 2^63-1 and `mean` as NaN, which
  // serialises to a nonsense 9223372036854.775 and a bare `null` — both of which
  // look like readings. Absent data must be visibly absent.
  eventLoopDelayMs: {
    observedForSec: number;
    samples: number;
    min: number | null;
    mean: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
  };
  mongoPool: {
    observedForSec: number | null;
    checkedOutNow: number;
    checkedOutPeak: number;
    connectionsOpenNow: number;
    connectionsOpenPeak: number;
    checkOutWaitMs: { max: number; mean: number; samples: number };
    totals: Record<string, number>;
  };
}

/**
 * @param resetLoopDelay start a fresh event-loop-delay window after reading, so
 * successive polls describe the interval between them instead of all of history.
 */
export function getProcessMetrics(resetLoopDelay = false): ProcessMetricsSnapshot {
  const mem = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const cpu = process.cpuUsage();
  const uptime = process.uptime();
  const h = ensureLoopDelay();

  // Nanoseconds → milliseconds, but only once the histogram has samples —
  // otherwise every field is a sentinel masquerading as a measurement.
  const samples = h.count ?? 0;
  const ns = (n: number) =>
    samples > 0 && Number.isFinite(n) ? round(n / 1e6, 3) : null;

  // Node >= 19 reads the cgroup limit; on older runtimes the method is absent.
  const constrained = (
    process as unknown as { constrainedMemory?: () => number | undefined }
  ).constrainedMemory?.();

  const snapshot: ProcessMetricsSnapshot = {
    timestamp: new Date().toISOString(),
    uptimeSec: round(uptime),
    runtime: {
      node: process.version,
      transpilingAtRuntime: process.execArgv.some((a) =>
        /tsx|ts-node|swc-node|esbuild-register/.test(a)
      ),
      execArgv: process.execArgv,
      nodeEnv: process.env.NODE_ENV,
      maxOldSpaceMb: mb(heap.heap_size_limit),
      constrainedMemoryMb:
        typeof constrained === "number" && constrained > 0 ? mb(constrained) : null,
    },
    memoryMb: {
      rss: mb(mem.rss),
      heapTotal: mb(mem.heapTotal),
      heapUsed: mb(mem.heapUsed),
      external: mb(mem.external),
      arrayBuffers: mb(mem.arrayBuffers),
      rssMinusHeapTotal: mb(Math.max(0, mem.rss - mem.heapTotal)),
      peakRss: mb(process.resourceUsage().maxRSS * 1024),
    },
    heap: {
      totalHeapSizeMb: mb(heap.total_heap_size),
      usedHeapSizeMb: mb(heap.used_heap_size),
      heapSizeLimitMb: mb(heap.heap_size_limit),
      mallocedMemoryMb: mb(heap.malloced_memory),
      externalMemoryMb: mb(heap.external_memory ?? 0),
      numberOfNativeContexts: heap.number_of_native_contexts,
      numberOfDetachedContexts: heap.number_of_detached_contexts,
    },
    cpu: {
      userSec: round(cpu.user / 1e6),
      systemSec: round(cpu.system / 1e6),
      avgCoresSinceBoot:
        uptime > 0 ? round((cpu.user + cpu.system) / 1e6 / uptime, 4) : 0,
    },
    eventLoopDelayMs: {
      observedForSec: round((Date.now() - state.loopDelaySince) / 1000),
      samples,
      min: ns(h.min),
      mean: ns(h.mean),
      p50: ns(h.percentile(50)),
      p95: ns(h.percentile(95)),
      p99: ns(h.percentile(99)),
      max: ns(h.max),
    },
    mongoPool: {
      observedForSec: pool.since ? round((Date.now() - pool.since) / 1000) : null,
      checkedOutNow: pool.checkedOutNow,
      checkedOutPeak: pool.checkedOutPeak,
      connectionsOpenNow: pool.connectionsOpenNow,
      connectionsOpenPeak: pool.connectionsOpenPeak,
      checkOutWaitMs: {
        max: round(pool.checkOutWaitMsMax, 3),
        mean: pool.checkOutWaitSamples
          ? round(pool.checkOutWaitMsTotal / pool.checkOutWaitSamples, 3)
          : 0,
        samples: pool.checkOutWaitSamples,
      },
      totals: { ...pool.totals },
    },
  };

  if (resetLoopDelay) {
    h.reset();
    state.loopDelaySince = Date.now();
  }

  return snapshot;
}
