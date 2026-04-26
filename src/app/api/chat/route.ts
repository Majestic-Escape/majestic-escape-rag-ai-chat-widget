import { GoogleGenAI } from "@google/genai";
import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import clientPromise from "@/lib/mongodb";
import {
  validateUserMessage,
  looksLikeInjection,
  truncateHistory,
  redactForLogs,
  sanitizeText,
  SAFETY_DIRECTIVE,
} from "@/lib/moderation";
import { checkRateLimit, ipFromHeaders } from "@/lib/rateLimit";
import { extractDateRange } from "@/lib/dateRange";
import { verifyToken } from "@/lib/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE_STATUS = "active";
// Per-minute rate limits — JWT-bearing (logged-in) callers get a higher ceiling.
const CHAT_PER_MIN_USER = 60;
const CHAT_PER_MIN_IP = 15;
const CHAT_RATE_WINDOW_MS = 60_000;
// Daily soft caps (env-overridable). Bounds worst-case attacker cost regardless of IP rotation.
const DAILY_LIMIT_USER = Number(process.env.DAILY_AI_LIMIT_USER ?? "200");
const DAILY_LIMIT_IP = Number(process.env.DAILY_AI_LIMIT_IP ?? "30");
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

const SUPPORT_RESPONSE =
  "Thanks for reaching out to Majestic Support! An agent will be with you shortly. For real-time chat with our team, switch to the Support tab. Otherwise, share your booking reference number and a brief description of your issue and we'll get back to you as soon as possible.";

const BASE_SYSTEM_PROMPT = `You are "Majestic AI", a warm and knowledgeable travel assistant for Majestic Escape — a curated vacation rental platform featuring handpicked stays across India (Goa, Rajasthan, Maharashtra, Kerala, and more).

Your role:
- Help guests discover the perfect stays, villas, and retreats
- Answer questions about properties, amenities, check-in/check-out, pricing, and policies
- Suggest destinations and travel tips for Indian holidays
- Assist with booking-related questions

Tone: Warm, professional, and modern — similar to Airbnb's assistant aesthetic.

LENGTH — STRICT:
- Reply with ONE short paragraph only. No bullet lists, no headers, no multi-paragraph answers.
- Keep total response under 60 words.
- Mention at most 2 properties by name in the paragraph; the cards below show the rest.
- Skip pleasantries like "I'd be happy to help"; get straight to the recommendation.

PROPERTY MENTIONS — IMPORTANT:
- Refer to properties by their full name only. Do NOT include URLs, raw IDs, or "/stay/..." paths in your reply.
- The user sees clickable property cards rendered below your message — those are the navigation. Your job is to summarise; the cards handle the linking.
- Example GOOD: "Royal Palace in Margao is a great match — pool, hot tub, ₹1,500/night."
- Example BAD: "Royal Palace (/stay/6957b9ec...) - features a pool..."
- If you mention that a property is fully booked for the user's dates, suggest one of the available alternatives from the list.
- If a user asks for human support, let them know they can switch to the "Support" tab at the top of the chat.`;

interface PropertyResult {
  _id: ObjectId | string;
  title: string;
  propertyType: string;
  placeType: string;
  address: { city: string; state: string };
  basePrice: number;
  guests: number;
  bedrooms: number;
  amenities: string[];
  averageRating: number;
  reviewCount: number;
  photos: string[];
  bookingType: { instantBook: boolean };
  score?: number;
  partiallyBooked?: boolean;
}

const PROPERTY_LINK_BASE =
  process.env.NEXT_PUBLIC_PROPERTY_BASE_URL ?? "https://majesticescape.in";

// Append an AI chat exchange to the audit/history collection. Fire-and-forget;
// failures log but never break the response stream.
//
// Model replies persist their property-card array too so the same cards
// reappear when the user reloads. Without this, restored history shows the
// reply text but not the cards that were below it.
async function persistAiMessage(entry: {
  userId: ObjectId | null;
  guestSessionId: string | null;
  role: "user" | "model";
  text: string;
  properties?: unknown[];
}): Promise<void> {
  try {
    if (!entry.text) return;
    const client = await clientPromise;
    const uri = process.env.MONGODB_URI || "";
    const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
    const db = client.db(dbName);
    const doc: Record<string, unknown> = {
      userId: entry.userId,
      guestSessionId: entry.guestSessionId,
      role: entry.role,
      text: entry.text.slice(0, 4000),
      createdAt: new Date(),
    };
    if (entry.properties && entry.properties.length > 0) {
      doc.properties = entry.properties;
    }
    await db.collection("ai_chat_messages").insertOne(doc);
  } catch (err) {
    console.warn("[chat] persist failed:", (err as Error).message);
  }
}

async function embedQuery(query: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY!;
  const res = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: query }] },
    }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  const data = await res.json();
  return data.embedding.values;
}

async function vectorSearch(queryEmbedding: number[], limit = 10): Promise<PropertyResult[]> {
  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);

  const results = await db
    .collection("listingproperties")
    .aggregate([
      {
        $vectorSearch: {
          index: "listing_vector_index",
          path: "embedding",
          queryVector: queryEmbedding,
          numCandidates: 100,
          limit,
          filter: { status: ACTIVE_STATUS },
        },
      },
      {
        $project: {
          title: 1,
          propertyType: 1,
          placeType: 1,
          address: 1,
          basePrice: 1,
          guests: 1,
          bedrooms: 1,
          amenities: 1,
          averageRating: 1,
          reviewCount: 1,
          photos: 1,
          bookingType: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ])
    .toArray();

  return results as PropertyResult[];
}

// Returns set of propertyIds (as string) that are blocked for the requested range.
async function findBlockedPropertyIds(
  propertyIds: ObjectId[],
  from: Date,
  to: Date
): Promise<Set<string>> {
  if (!propertyIds.length) return new Set();
  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);
  const blocking = await db
    .collection("bookings")
    .find(
      {
        propertyId: { $in: propertyIds },
        status: { $in: ["confirmed", "pending"] },
        checkIn: { $lt: to },
        checkOut: { $gt: from },
      },
      { projection: { propertyId: 1 } }
    )
    .toArray();
  return new Set(blocking.map((b) => String(b.propertyId)));
}

function buildContext(properties: PropertyResult[]): string {
  if (!properties.length) return "No specific properties found matching this query.";

  return properties
    .map((p, i) => {
      const location = [p.address?.city, p.address?.state].filter(Boolean).join(", ");
      const amenityList = p.amenities?.slice(0, 6).join(", ") || "Various amenities";
      const rating =
        p.averageRating > 0 ? `${p.averageRating}/5 (${p.reviewCount} reviews)` : "New listing";
      return [
        `[Property ${i + 1}]`,
        `ID: ${p._id}`,
        `Title: ${p.title}`,
        `Type: ${p.propertyType}, ${p.placeType}`,
        `Location: ${location}, India`,
        `Price: ₹${p.basePrice}/night`,
        `Capacity: ${p.guests} guests, ${p.bedrooms} bedrooms`,
        `Amenities: ${amenityList}`,
        `Rating: ${rating}`,
        p.partiallyBooked ? "Availability: BOOKED for the requested dates" : "Availability: open",
        p.bookingType?.instantBook ? "Instant Book available" : "Manual approval required",
        `Link: ${PROPERTY_LINK_BASE}/stay/${p._id}`,
      ].join("\n");
    })
    .join("\n\n");
}

export async function POST(req: NextRequest) {
  try {
    // ── Identity + rate limit (cheap rejection before body parse) ──
    // Prefer JWT identity when present so legitimate logged-in users get a higher ceiling.
    const ip = ipFromHeaders(req.headers);
    const authHeader = req.headers.get("authorization") || "";
    const bearer = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;
    const jwt = bearer ? verifyToken(bearer) : null;
    const userIdRaw =
      typeof jwt?.userId === "string"
        ? jwt.userId
        : typeof jwt?.id === "string"
        ? jwt.id
        : null;

    // Origin allow-list — cross-origin or missing-Origin callers are halved.
    const origin = req.headers.get("origin") || "";
    const originTrusted =
      origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin));

    const minutelyLimit = userIdRaw
      ? CHAT_PER_MIN_USER
      : Math.max(1, Math.floor(CHAT_PER_MIN_IP * (originTrusted ? 1 : 0.5)));
    const dailyLimit = userIdRaw
      ? DAILY_LIMIT_USER
      : Math.max(1, Math.floor(DAILY_LIMIT_IP * (originTrusted ? 1 : 0.5)));
    const identityKey = userIdRaw ? `user:${userIdRaw}` : `ip:${ip}`;

    const minutely = checkRateLimit(`chat:m:${identityKey}`, minutelyLimit, CHAT_RATE_WINDOW_MS);
    if (!minutely.ok) {
      return new Response(
        JSON.stringify({ error: "Too many requests, please slow down." }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": Math.ceil(minutely.retryAfterMs / 1000).toString(),
          },
        }
      );
    }
    const daily = checkRateLimit(`chat:d:${identityKey}`, dailyLimit, DAILY_WINDOW_MS);
    if (!daily.ok) {
      return new Response(
        JSON.stringify({
          error: userIdRaw
            ? "Daily AI limit reached. Try again tomorrow."
            : "Daily AI limit reached for this network. Sign in for a higher limit.",
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": Math.ceil(daily.retryAfterMs / 1000).toString(),
          },
        }
      );
    }

    let body: { message?: unknown; history?: unknown; mode?: unknown; guestSessionId?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const { message, history, mode, guestSessionId: bodyGuestId } = body;
    const guestSessionId =
      !userIdRaw && typeof bodyGuestId === "string" && bodyGuestId.length <= 100
        ? bodyGuestId
        : null;

    const validation = validateUserMessage(message);
    if (!validation.ok) {
      return new Response(JSON.stringify({ error: validation.reason }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Strip control chars before any downstream use (logs, persistence, LLM).
    const cleanMessage = sanitizeText((message as string).trim());
    if (!cleanMessage) {
      return new Response(JSON.stringify({ error: "Message is empty" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (looksLikeInjection(cleanMessage)) {
      console.warn(
        `[chat/route] possible prompt-injection attempt from ${ip}:`,
        redactForLogs(cleanMessage).slice(0, 200)
      );
      // Don't reject outright — the safety directive in the system prompt handles it
      // gracefully; rejecting causes false positives for legitimate questions.
    }

    const safeHistory = truncateHistory(history);

    if (mode === "support") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${SUPPORT_RESPONSE}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    // ── Persist the user's AI message (fire-and-forget; identity-bound) ──
    // Only one of userId / guestSessionId is set; both null means anonymous-no-cookie
    // and that row is skipped (we have no way to fetch it back later).
    const persistIdentity =
      userIdRaw || guestSessionId
        ? { userId: userIdRaw ? new ObjectId(userIdRaw) : null, guestSessionId }
        : null;
    if (persistIdentity) {
      void persistAiMessage({
        ...persistIdentity,
        role: "user",
        text: cleanMessage,
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    let contextBlock = "";
    let cardProperties: PropertyResult[] = [];
    try {
      const queryEmbedding = await embedQuery(cleanMessage);
      const candidates = await vectorSearch(queryEmbedding, 12);
      if (candidates.length > 0) {
        // Booking-aware filtering — search in message + last user history turn
        const historyText = safeHistory
          .filter((m) => m.role === "user")
          .slice(-2)
          .map((m) => m.text)
          .join(" ");
        const range = extractDateRange(`${cleanMessage} ${historyText}`);
        if (range) {
          const ids = candidates
            .map((p) => (typeof p._id === "string" ? new ObjectId(p._id) : p._id))
            .filter(Boolean) as ObjectId[];
          const blocked = await findBlockedPropertyIds(ids, range.from, range.to);
          for (const c of candidates) {
            if (blocked.has(String(c._id))) c.partiallyBooked = true;
          }
        }
        // Top 8: prefer available, then by score. Score>0.5 filter (below)
        // still drops genuine non-matches even when 8 slots are available.
        const sorted = candidates
          .slice()
          .sort((a, b) => {
            if (!!a.partiallyBooked === !!b.partiallyBooked) {
              return (b.score ?? 0) - (a.score ?? 0);
            }
            return a.partiallyBooked ? 1 : -1;
          })
          .slice(0, 8);
        const context = buildContext(sorted);
        contextBlock = `\n\nRELEVANT PROPERTIES FROM OUR DATABASE:\n${context}\n\nWhen recommending properties, only mention those listed above. Use the property's title (name) only — do NOT echo the ID, URL, or Link field in your text response. The user sees clickable cards below.`;
        cardProperties = sorted.filter((p) => (p.score ?? 1) > 0.5);
      }
    } catch (ragErr) {
      console.warn("[chat/route] RAG unavailable, falling back:", (ragErr as Error).message);
    }

    const systemPrompt = BASE_SYSTEM_PROMPT + contextBlock + SAFETY_DIRECTIVE;

    const cardData = cardProperties.map((p) => ({
      _id: String(p._id),
      title: p.title,
      propertyType: p.propertyType,
      address: { city: p.address?.city, state: p.address?.state },
      basePrice: p.basePrice,
      averageRating: p.averageRating,
      reviewCount: p.reviewCount,
      photos: p.photos?.slice(0, 1) ?? [],
      guests: p.guests,
      bedrooms: p.bedrooms,
      partiallyBooked: !!p.partiallyBooked,
    }));

    const encoder = new TextEncoder();

    type FallbackProvider = "gemini" | "groq" | "xai";
    let provider: FallbackProvider = "gemini";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let geminiResponseStream: AsyncIterable<any> | null = null;

    try {
      const ai = new GoogleGenAI({ apiKey });
      const geminiHistory = safeHistory.map((msg) => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.text }],
      }));
      const chat = ai.chats.create({
        model: "gemini-2.0-flash",
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.5,
          maxOutputTokens: 180,
        },
        history: geminiHistory,
      });
      geminiResponseStream = await chat.sendMessageStream({ message: cleanMessage });
    } catch (geminiErr) {
      const status = (geminiErr as { status?: number }).status;
      if (status === 429) {
        const groqKey = process.env.GROQ_API_KEY;
        const xaiKey = process.env.XAI_API_KEY;
        if (groqKey) {
          console.warn("[chat/route] Gemini quota hit, falling back to Groq");
          provider = "groq";
        } else if (xaiKey) {
          console.warn("[chat/route] Gemini quota hit (no Groq key), falling back to xAI");
          provider = "xai";
        } else {
          throw geminiErr;
        }
      } else {
        throw geminiErr;
      }
    }

    const openAiMessages = [
      { role: "system", content: systemPrompt },
      ...safeHistory.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      })),
      { role: "user", content: cleanMessage },
    ];

    // Assembled model reply — captured across all provider paths for persistence.
    let assembledReply = "";

    async function streamOpenAICompatible(
      url: string,
      authKey: string,
      model: string,
      controller: ReadableStreamDefaultController
    ) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${authKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: openAiMessages,
          stream: true,
          temperature: 0.5,
          max_tokens: 180,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`${url} request failed: ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const text = JSON.parse(payload).choices?.[0]?.delta?.content;
            if (text) {
              assembledReply += text;
              controller.enqueue(encoder.encode(`data: ${text.replace(/\n/g, "\\n")}\n\n`));
            }
          } catch { /* skip malformed chunks */ }
        }
      }
    }

    const stream = new ReadableStream({
      async start(controller) {
        const emitDone = () => {
          if (cardData.length > 0) {
            controller.enqueue(encoder.encode(`data: [PROPS]${JSON.stringify(cardData)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          // Persist the assembled model reply once the stream completes.
          if (persistIdentity && assembledReply.trim()) {
            void persistAiMessage({
              ...persistIdentity,
              role: "model",
              text: assembledReply.trim(),
              properties: cardData.length > 0 ? cardData : undefined,
            });
          }
        };

        try {
          if (provider === "gemini" && geminiResponseStream) {
            for await (const chunk of geminiResponseStream) {
              const text = chunk.text;
              if (text) {
                assembledReply += text;
                controller.enqueue(encoder.encode(`data: ${text.replace(/\n/g, "\\n")}\n\n`));
              }
            }
          } else if (provider === "groq") {
            const groqKey = process.env.GROQ_API_KEY!;
            await streamOpenAICompatible(
              "https://api.groq.com/openai/v1/chat/completions",
              groqKey,
              "llama-3.3-70b-versatile",
              controller
            );
          } else {
            const xaiKey = process.env.XAI_API_KEY;
            if (!xaiKey) throw new Error("No AI provider available");
            await streamOpenAICompatible(
              "https://api.x.ai/v1/chat/completions",
              xaiKey,
              "grok-3-mini",
              controller
            );
          }
          emitDone();
        } catch (streamErr) {
          console.error("[chat/route] Stream error:", streamErr);
          controller.enqueue(
            encoder.encode(`data: Sorry, I ran into an issue. Please try again.\n\n`)
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error("Chat route error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
