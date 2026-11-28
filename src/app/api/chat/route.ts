import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import clientPromise, { appDbName } from "@/lib/mongodb";
import { validateUserMessage, looksLikeInjection, sanitizeText } from "@/lib/moderation";
import { checkRateLimit, withKeyLock } from "@/lib/rateLimit";
import { isAiEnabled } from "@/lib/aiToggle";
import { handleTurn, type TurnResult } from "@/lib/rag/pipeline";
import { AVAILABLE_NOTE, FIXED, RECHECK_NOTE, headingFor } from "@/lib/rag/reply";
import { aiDraftEnabled, chatIdentity, datedSearchEnabled, pilotLive, pipelineMode, productionDeps, searchMode } from "@/lib/rag/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-minute rate limits — JWT-bearing (logged-in) callers get a higher ceiling.
const CHAT_PER_MIN_USER = 60;
const CHAT_PER_MIN_IP = 15;
// Filter buttons: no model call, one search each. Generous enough for a guest tapping through chips.
const OPS_PER_MIN_USER = 60;
const OPS_PER_MIN_IP = 40;
const CHAT_RATE_WINDOW_MS = 60_000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
// One deadline for the whole turn: model attempts, search pages and state writes
// all stop here, or sooner if the customer's browser goes away.
const TURN_DEADLINE_MS = 9000;

const SUPPORT_RESPONSE =
  "Thanks for reaching out to Majestic Support! An agent will be with you shortly. For real-time chat with our team, switch to the Support tab. Otherwise, share your booking reference number and a brief description of your issue and we'll get back to you as soon as possible.";

// Append an AI chat exchange to the audit/history collection. Fire-and-forget;
// failures log but never break the response.
//
// Model replies persist their property-card array too so the same cards
// reappear when the user reloads.
async function persistAiMessage(entry: {
  userId: ObjectId | null;
  guestSessionId: string | null;
  role: "user" | "model";
  text: string;
  properties?: unknown[];
}): Promise<void> {
  try {
    if (!entry.text) return;
    const db = (await clientPromise).db(appDbName());
    const doc: Record<string, unknown> = {
      userId: entry.userId,
      guestSessionId: entry.guestSessionId,
      role: entry.role,
      text: entry.text.slice(0, 4000),
      createdAt: new Date(),
    };
    if (entry.properties && entry.properties.length > 0) doc.properties = entry.properties;
    await db.collection("ai_chat_messages").insertOne(doc);
  } catch (err) {
    console.warn("[chat] persist failed:", (err as Error).message);
  }
}

// The widget's stream format (src/embed/useChat.ts): one `data:` line per text
// chunk with newlines escaped, an optional `[PROPS]` line, then `[DONE]`.
// Text goes first: the widget hides a reply until it has text.
const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };

/** One text chunk in the widget's format: newlines escaped; a reply that happens
 *  to begin with one of the widget's own markers (a stay titled "[PROPS]…") gets
 *  a leading space so it stays text. */
function sseText(text: string): string {
  const safe = /^\[(PROPS|DONE|META)\]/.test(text) ? ` ${text}` : text;
  return safe.replace(/\r/g, "").replace(/\n/g, "\\n");
}

function sse(text: string, cards: unknown[] = []): Response {
  let body = `data: ${sseText(text)}\n\n`;
  if (cards.length > 0) body += `data: [PROPS]${JSON.stringify(cards)}\n\n`;
  body += "data: [DONE]\n\n";
  return new Response(body, { headers: SSE_HEADERS });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export async function POST(req: NextRequest) {
  try {
    // ── Ops kill-switch — MUST stay the first statement in this handler ──
    // Every path below this line can cost money: rate-limiter bookkeeping, the
    // model call and the catalogue search. Returning here is what makes the
    // admin toggle an actual spend control rather than a UI preference.
    //
    // The widget also hides its AI tab when disabled, but that is cosmetic —
    // the bundle is loaded cross-origin and anyone can POST here directly, so
    // this server-side check is the only real guarantee. Do not move it below
    // the rate limiter "for consistency": isAiEnabled() is cache-backed and
    // cheaper than the limiter's own bookkeeping.
    if (!(await isAiEnabled())) return json(403, { error: "ai_disabled" });

    // ── Identity + rate limit (cheap rejection before body parse) ──
    // Prefer JWT identity when present so legitimate logged-in users get a higher ceiling.
    // The same derivation as /api/chat/history and /api/chat/config (one canary decision for all three).
    const { userId: userIdRaw, ip } = chatIdentity(req.headers, undefined);

    // Origin allow-list — cross-origin or missing-Origin callers are halved.
    const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get("origin") || "";
    const originTrusted = origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin));
    const share = originTrusted ? 1 : 0.5;

    const minutelyLimit = userIdRaw ? CHAT_PER_MIN_USER : Math.max(1, Math.floor(CHAT_PER_MIN_IP * share));
    // Typed requests per day: a signed-in person, and a guest device (10 each by default). The network limit
    // stays higher on purpose: many phones in India share one address (carrier NAT); it is the abuse backstop.
    const dailyLimit = userIdRaw
      ? Number(process.env.DAILY_AI_LIMIT_USER ?? "10")
      : Math.max(1, Math.floor(Number(process.env.DAILY_AI_LIMIT_IP ?? "30") * share));
    const identityKey = userIdRaw ? `user:${userIdRaw}` : `ip:${ip}`;

    let body: { message?: unknown; mode?: unknown; guestSessionId?: unknown; reset?: unknown; caps?: unknown; op?: unknown; quick?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
    const { message, mode } = body;
    const who = chatIdentity(req.headers, body.guestSessionId);
    const guestSessionId = who.guestId;
    // A filter button (an op), "Start fresh" or a quick answer ("Yes, show them") never calls a model (the pipeline
    // ends them without one), so they are not counted against the daily limit that protects model spend; their own
    // per-minute limit protects the site's search API. Typed messages keep both limits.
    const isButton = (!!body.op && typeof body.op === "object") || body.reset === true || body.quick === true;
    const minutely = isButton
      ? checkRateLimit(`chat:op:${identityKey}`, userIdRaw ? OPS_PER_MIN_USER : Math.max(1, Math.floor(OPS_PER_MIN_IP * share)), CHAT_RATE_WINDOW_MS)
      : checkRateLimit(`chat:m:${identityKey}`, minutelyLimit, CHAT_RATE_WINDOW_MS);
    if (!minutely.ok) {
      return json(429, { error: "Too many requests, please slow down." }, { "Retry-After": Math.ceil(minutely.retryAfterMs / 1000).toString() });
    }
    const guestLimit = Number(process.env.DAILY_AI_LIMIT_GUEST ?? "10");
    const daily = isButton
      ? { ok: true as const, retryAfterMs: 0 }
      : (() => {
          const net = checkRateLimit(`chat:d:${identityKey}`, dailyLimit, DAILY_WINDOW_MS);
          if (!net.ok || userIdRaw || !guestSessionId) return net;
          return checkRateLimit(`chat:d:g:${guestSessionId}`, guestLimit, DAILY_WINDOW_MS);
        })();
    if (!daily.ok) {
      const filtersOn = searchMode() === "filters";
      return json(
        429,
        { error: filtersOn ? "You've reached today's limit for typed requests. The filter buttons still work." : userIdRaw ? "Daily AI limit reached. Try again tomorrow." : "Daily AI limit reached for this network. Sign in for a higher limit." },
        { "Retry-After": Math.ceil(daily.retryAfterMs / 1000).toString() }
      );
    }

    const validation = validateUserMessage(message);
    if (!validation.ok) return json(400, { error: validation.reason });
    // Strip control chars before any downstream use (logs, persistence, model).
    const cleanMessage = sanitizeText((message as string).trim());
    if (!cleanMessage) return json(400, { error: "Message is empty" });

    if (looksLikeInjection(cleanMessage)) {
      // Logged, not rejected: the model's output is only ever read as a strictly
      // validated JSON proposal, and no model text reaches the customer. Neither the text nor the address is
      // logged: logs carry no customer data.
      console.warn(`[chat/route] possible prompt-injection attempt (${cleanMessage.length} chars)`);
    }

    if (mode === "support") return sse(SUPPORT_RESPONSE);

    // ── Persist the user's AI message (fire-and-forget; identity-bound) ──
    // Only one of userId / guestSessionId is set; both null means anonymous-no-cookie
    // and that row is skipped (we have no way to fetch it back later).
    // The widget's "Start fresh" is an action, not a message: nothing of it is saved.
    const isReset = body.reset === true;
    const persistIdentity =
      !isReset && (userIdRaw || guestSessionId) ? { userId: userIdRaw ? new ObjectId(userIdRaw) : null, guestSessionId } : null;
    if (persistIdentity) void persistAiMessage({ ...persistIdentity, role: "user", text: cleanMessage });
    const saveReply = (text: string, cards: unknown[] = []) => {
      if (!persistIdentity) return;
      // By the time a saved reply is restored its availability is history: it is
      // stored as "recheck", never as "available".
      const saved = cards.map((c) => {
        const { availability, ...rest } = c as Record<string, unknown>;
        return availability === "available" ? { ...rest, availability: "recheck" } : rest;
      });
      void persistAiMessage({ ...persistIdentity, role: "model", text: text.replace(AVAILABLE_NOTE, RECHECK_NOTE), properties: saved });
    };
    const reply = (text: string, cards: unknown[] = []) => {
      saveReply(text, cards);
      return sse(text, cards);
    };

    // ── The search pipeline (src/lib/rag) ──
    // `safe` is the default and the rollback target: no model, no claims.
    const key = who.key;
    const pipeline = pipelineMode();
    const live = pilotLive(who);
    if (!live && pipeline !== "shadow") return reply(FIXED.safe);

    const deps = await productionDeps();
    // Shadow: the customer gets the safe reply; the new pipeline runs beside it
    // on its own copy of the state, and only its log line is kept.
    const turnKey = live ? key : key ? `shadow:${key}` : null;
    // One turn per identity at a time, in arrival order — a slow earlier turn
    // cannot overwrite what a later message asked for.
    // The deadline starts when the turn starts running, not while it waits its
    // turn — and a caller with no identity has no state to protect, so no queue.
    const op = body.op && typeof body.op === "object" ? (body.op as Record<string, unknown>) : undefined;
    // Filters mode (the default): the guest sets the search with buttons; a typed message is at most a draft
    // they confirm (RAG_AI_DRAFT=on), never applied by itself. A bundle older than the filter buttons (caps < 2)
    // gets the safe reply. Chat mode applies the reading directly (held to the release gates).
    const filters = searchMode() === "filters";
    const caps = typeof body.caps === "number" ? body.caps : 0;
    if (filters && caps < 2 && !isReset) return reply(FIXED.safe); // "Start fresh" clears the search from any bundle
    const readMode = filters ? (aiDraftEnabled() ? "draft" : "off") : "apply";
    const dated = datedSearchEnabled();
    const run = (onStage?: (stage: "searching") => void): Promise<TurnResult> => {
      const turn = () =>
        handleTurn(
          { message: cleanMessage, key: turnKey, reset: isReset, op, onStage, readMode, dated, fastOnly: body.quick === true },
          deps,
          AbortSignal.any([req.signal, AbortSignal.timeout(TURN_DEADLINE_MS)])
        );
      return turnKey ? withKeyLock(`ai:${turnKey}`, turn) : turn();
    };
    const logTurn = (r: TurnResult) => console.log(JSON.stringify({ t: "rag", mode: pipeline, ...r.log }));

    if (!live) {
      void run().then(logTurn, () => {});
      return reply(FIXED.safe);
    }

    // Widgets that understand `[META]` say so (`caps`). Older bundles — cached for
    // up to a day — would print an unknown marker as text, so they get the plain
    // reply: the filters as its first line, no status, no headings.
    if (caps < 1) {
      let result: TurnResult;
      try {
        result = await run();
      } catch (err) {
        // The lock gave up waiting (an earlier turn of this customer is still running).
        console.warn("[chat/route] turn did not run:", (err as Error).message);
        return reply(FIXED.retry);
      }
      logTurn(result);
      return reply(result.text, result.cards);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: string) => {
          try { controller.enqueue(encoder.encode(`data: ${line}\n\n`)); } catch { /* the customer left */ }
        };
        let result: TurnResult | null = null;
        try {
          result = await run(() => send(`[META]${JSON.stringify({ status: "Searching stays…" })}`));
          logTurn(result);
        } catch (err) {
          console.warn("[chat/route] turn did not run:", (err as Error).message);
        }
        const text = result?.text ?? FIXED.retry;
        const cards = result?.cards ?? [];
        saveReply(text, cards); // the saved text keeps the filters line: restored history has no chips
        let visible = text;
        if (filters && result) {
          // caps 2: the filters (possibly none), the state the filter editor starts from, and any draft
          const { shownIds: _s, consentFor: _c, ...search } = result.state;
          send(`[META]${JSON.stringify({
            filters: result.chips ?? [],
            heading: headingFor(result.cards),
            search,
            controls: { draft: readMode === "draft" },
            ...(result.draft ? { draft: result.draft } : {}),
            ...(result.pending?.kind === "consent" ? { quick: ["Yes, show them", "No"] } : {}),
          })}`);
          const rest = text.split("\n").filter((line) => line !== result!.chipsLine).join("\n");
          if (rest.trim()) visible = rest;
        } else if (result?.chips?.length) {
          send(`[META]${JSON.stringify({ filters: result.chips, heading: headingFor(result.cards) })}`);
          const rest = text.split("\n").filter((line) => line !== result!.chipsLine).join("\n");
          if (rest.trim()) visible = rest;
        }
        send(sseText(visible));
        if (cards.length > 0) send(`[PROPS]${JSON.stringify(cards)}`);
        send("[DONE]");
        try { controller.close(); } catch { /* already closed */ }
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  } catch (err) {
    console.error("Chat route error:", err);
    return json(500, { error: "Internal server error" });
  }
}
