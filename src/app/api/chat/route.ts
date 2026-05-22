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
- If a user asks for human support, let them know they can switch to the "Support" tab at the top of the chat.

LOCATION ACCURACY — STRICT:
- Only state that a property is "in" or "near" a location if the property's own data (city, state) explicitly supports it. Never infer geographic proximity to match the user's query.
- If the search returns no properties in the user's requested location, say so honestly: e.g. "I don't currently have listings in Mumbai, but here are some other stays you might like." Only name a city or state if it actually appears in the property data provided to you this turn — never invent, guess, or infer one.
- Do NOT claim a Goa property is "near Mumbai" or a Maharashtra property is "near Delhi" — these are factually wrong and mislead guests.
- If the user asks for stays "near me / nearby / in my area" and you cannot identify a city/area/landmark anywhere in their messages, ask them where they are before recommending anything. Do not fall back on whatever Goa/Maharashtra results the search produced — those would be wrong.`;

// Appended when the user asks for stays "near me" / "nearby" / "in my area"
// without naming a city. We don't auto-locate the browser, so the only honest
// response is to ask. Without this directive the LLM either guesses a city
// from earlier turns or hallucinates a recommendation — both bad UX.
const LOCATION_REQUIRED_DIRECTIVE = `

LOCATION-NEEDED MODE — STRICT (this turn):
- The user asked for stays near them, nearby, or in their area, but did NOT name a city/area.
- We do NOT know the user's location. Do not guess, do not pull a city from earlier turns, do not assume.
- Reply with ONE short friendly question asking where they are right now. Example: "Happy to find stays near you! Which city or area are you in?"
- Do NOT recommend any properties this turn. Do NOT mention any property names.
- Do NOT include phrases like "based on your location" or "in your area" in the reply — you genuinely don't have it yet.`;

// Appended to the system prompt only when the intent gate decides this turn
// is conversational (greeting / thanks / policy / booking-mgmt / meta).
// Without this, the LLM's discovery-mode default leaks property names from
// the conversation history even when the user is just saying "hi" or "ok".
const CONVERSATIONAL_DIRECTIVE = `

CONVERSATIONAL MODE — STRICT (this turn):
- The user's current message is conversational (greeting, thanks, policy question, booking-management, or meta question about you).
- Reply briefly and warmly. ONE short sentence is ideal; two max.
- Do NOT recommend, list, mention, or "consider" any specific property — even if earlier turns mentioned them. The user did not ask for a recommendation right now.
- For greetings/thanks/fillers: a friendly acknowledgement (e.g. "Hi! What kind of stay are you looking for?", "You're welcome!").
- For "what's your cancellation policy" / refund / payment / privacy / terms: give a brief generic answer and point them to the property page or Support tab for specifics. Don't invent platform-wide policy.
- For booking-management ("cancel my booking", "my reservation", "change my dates"): tell them to switch to the "Support" tab where an agent can help.
- For meta ("who are you", "what can you do"): describe yourself in one line — Majestic AI, helps discover stays across India.
- NEVER include property names, prices, "match", "consider", "great option", or "explore" phrasing in this turn.`;

interface PropertyResult {
  _id: ObjectId | string;
  title: string;
  propertyType: string;
  placeType: string;
  address: { city: string; state: string; district?: string };
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

// Decide whether to run vector search + show property cards for this turn.
// Conversational filler ("hi", "thanks"), policy questions ("cancellation
// policy"), booking-management ("cancel my booking"), and meta questions
// ("who are you") should be answered conversationally without surfacing
// unrelated stays — even if cosine similarity squeaks above the score floor.
// Discovery messages ("villa in goa with a pool", "weekend stays under 5000")
// fall through to the default branch and trigger the RAG pipeline as before.
// "Stays near me" trigger — covers the common phrasings in English. If the
// user used one of these AND didn't accompany it with any other meaningful
// word (i.e. a city/area/landmark), we ask for their location.
const NEAR_ME_RE =
  /\b(near\s*me|near\s*by|nearby|close\s*(to|by)\s*me|around\s*me|in\s*my\s*(area|location|city|town|neighbourhood|neighborhood|vicinity|region|locality)|near\s*my\s*(location|place|area|city|town|home|spot)|where\s*i\s*am)\b/i;

// Travel-search fillers that don't carry location information. Anything
// alphabetic of length ≥ 3 left over after stripping these is treated as a
// possible location signal — including cities we've never heard of. This
// keeps the heuristic PAN-India safe: a user typing "stays near me in
// Bhopal" or "places nearby in Hampi" is NOT asked again, even though the
// platform never had to be told that Bhopal/Hampi are places. The bias is
// deliberately toward NOT asking — false-asking after a user named a city
// is a much worse UX than running vector search with weak signal.
//
// Update if you see the bot proceeding with RAG when the user clearly said
// nothing but the trigger; do NOT add city names here.
const LOCATION_FILLER_RE =
  /\b(stays?|hotels?|villas?|hostels?|resorts?|homestays?|cottages?|properties?|apartments?|places?|spots?|options?|find|show|get|give|tell|need|want|looking|search(?:ing)?|browse|recommend|suggest(?:ion)?s?|me|us|some|any|all|the|a|an|please|kindly|with|and|or|in|on|at|to|of|for|from|by|near|nearby|around|close|under|below|less|than|over|above|more|rs|inr|rupees?|good|nice|best|top|cheap|cheapest|affordable|budget|luxury|premium|pool|wifi|beach|mountain|mountains|hill|hills|view|sea|ocean|lake|river|today|tomorrow|tonight|weekend|night|nights|days?|week|month|guests?|people|persons?|kids?|children|family|couple|solo|i|am|is|are|was|were|will|would|can|could|may|might|peaceful|quiet|romantic|adventure|relaxing|cozy|spacious|what|whats|where|why|how|when|which|who|do|does|don|t|s|have|got|let|here|there)\b/gi;

function locationResidualWords(text: string): string[] {
  // After /[^a-z\s]/g, " " collapse, /g flag is needed on filler RE so
  // replace iterates across multiple matches in one string.
  return text
    .toLowerCase()
    .replace(NEAR_ME_RE, " ")
    .replace(LOCATION_FILLER_RE, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function needsLocationAsk(message: string, recentUserMessages: string[]): boolean {
  if (!NEAR_ME_RE.test(message)) return false;
  // If the user mentioned anything that survives the filler-strip in the
  // current message, treat it as a possible location signal and let RAG run.
  if (locationResidualWords(message).length > 0) return false;
  // Mirror the date-range carry-over (line ~434): scan up to the last 5
  // user turns. If the user said "I'm in Pune" three turns ago and now
  // says "stays nearby", we already know where they are. The cap matches
  // the existing date scanner so behaviour is consistent.
  for (const prior of recentUserMessages.slice(-5)) {
    if (locationResidualWords(prior).length > 0) return false;
  }
  return true;
}

function shouldUseRag(message: string): boolean {
  const msg = message.trim().toLowerCase();
  if (msg.length < 4) return false;
  if (
    /^(hi|hello|hey|yo|sup|thanks?|thank you|ok(ay)?|cool|great|awesome|nice|lol|haha|got it|sure|yes|no|yup|nope|alright)[\s!.?]*$/i.test(
      msg
    )
  ) {
    return false;
  }
  const policyTerms =
    /\b(cancellation|refund|privacy|terms|polic(y|ies)|faq|how do i (cancel|reset|change|update|edit)|contact (host|support|us)|customer (service|care|support)|help( center)?|password|sign in|login|account|profile|verify|verification|otp)\b/i;
  if (policyTerms.test(msg)) return false;
  const bookingMgmtTerms =
    /\b(my booking|my reservation|my stay|my trip|booking ref(erence)?|change my (booking|dates|stay)|modify (my )?booking|cancel my booking|check[ -]?in time|check[ -]?out time)\b/i;
  if (bookingMgmtTerms.test(msg)) return false;
  const metaTerms =
    /^(who are you|what can you do|what do you do|are you a (bot|human|real)|how (are you|do you work)|tell me about (yourself|majestic escape)|help)$/i;
  if (metaTerms.test(msg)) return false;
  return true;
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

// ── Card selection ─────────────────────────────────────────────────────────
// Generic words that appear inside many Indian place / district strings and so
// cannot, on their own, pin a query to one property — e.g. "Pradesh" is shared
// by Uttar Pradesh and Madhya Pradesh; "Road"/"Nagar"/"Waddo" are filler in
// district strings like "Dewas Road" or "Bouta Waddo". Excluded from the
// location vocabulary so only the distinctive token (Dewas, Bouta) counts.
const GEO_STOPWORDS = new Set([
  "pradesh", "india", "nagar", "city", "district", "town", "village",
  "east", "west", "north", "south", "central", "new", "old", "near",
  "road", "marg", "lane", "block", "sector", "phase", "colony", "society",
  "states", "state", "waddo", "wado", "extension", "main", "cross",
]);

// Lowercased alphabetic tokens (≥3 chars, non-generic) of a place string.
function placeTokens(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GEO_STOPWORDS.has(w));
}

// How close (cosine) a non-location card must score to the top hit to be
// shown. gemini-embedding-001 puts every property in a ~0.74–0.87 band, so an
// absolute floor is meaningless; a gap from the leader is what separates a
// real cluster of matches from the long tail of weak ones.
const CARD_SCORE_GAP = 0.04;
const MAX_CARDS = 8;

// The locality-level tokens of a property — city + district. District holds
// the neighbourhood / village / beach-area string (e.g. "Colva", "Kutch",
// "Cavellosim"), so a guest searching that locality still matches.
function localityTokens(p: PropertyResult): string[] {
  return [
    ...placeTokens(p.address?.city),
    ...placeTokens(p.address?.district),
  ];
}

// Choose which properties become cards (and the LLM's grounding set).
//
// If the query names a locality (city / district / village) or state we
// actually serve, show ONLY properties in that place — a "stays in Lucknow"
// query must never surface a Goa villa just because its embedding is
// semantically near. Otherwise (amenity / vibe / unserved-place queries) fall
// back to a relative-score gate so one strong match isn't buried under a tail
// of weak ones.
//
// Generic — knows no place by name. The vocabulary is built live from whatever
// properties exist, so it scales unchanged as the catalogue grows (e.g. four
// future properties all in "Vasco" → a "stays in Vasco" query returns exactly
// those four, and nothing from the rest of Goa).
function selectCards(query: string, ranked: PropertyResult[]): PropertyResult[] {
  if (ranked.length === 0) return [];

  // Two-tier place vocabulary, derived live from the candidate set:
  //  • locality = city + district tokens (the specific level)
  //  • state    = state tokens (the broad level)
  const localityVocab = new Set<string>();
  const stateVocab = new Set<string>();
  for (const p of ranked) {
    for (const t of placeTokens(p.address?.state)) stateVocab.add(t);
  }
  for (const p of ranked) {
    for (const t of localityTokens(p)) localityVocab.add(t);
  }
  // A token naming both a locality and a state (e.g. a property whose city
  // field is literally "Goa") is treated as the state — so "stays in Goa"
  // matches the whole region, not the lone property with that city value.
  for (const t of stateVocab) localityVocab.delete(t);

  const queryTokens = placeTokens(query);
  const namedLocalities = new Set(queryTokens.filter((t) => localityVocab.has(t)));
  const namedStates = new Set(queryTokens.filter((t) => stateVocab.has(t)));

  // Locality precedence: "villas in Vasco, Goa" means Vasco specifically — not
  // the whole state. Only fall back to a state match when no locality is named.
  if (namedLocalities.size > 0) {
    const matched = ranked.filter((p) =>
      localityTokens(p).some((t) => namedLocalities.has(t))
    );
    return matched.slice(0, MAX_CARDS);
  }
  if (namedStates.size > 0) {
    const matched = ranked.filter((p) =>
      placeTokens(p.address?.state).some((t) => namedStates.has(t))
    );
    return matched.slice(0, MAX_CARDS);
  }

  // No served place named — amenity / vibe / unserved-location query.
  const topScore = ranked[0].score ?? 0;
  return ranked
    .filter((p) => (p.score ?? 0) >= topScore - CARD_SCORE_GAP)
    .slice(0, MAX_CARDS);
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
    const recentUserText = safeHistory.filter((m) => m.role === "user").map((m) => m.text);
    const needsLocation = needsLocationAsk(cleanMessage, recentUserText);
    const isConversationalTurn = !shouldUseRag(cleanMessage);
    // needsLocation forces conversational mode (no vector search, no cards):
    // running RAG without a location yields irrelevant results, and the
    // directive below will steer the LLM to ask before suggesting anything.
    const skipRag = isConversationalTurn || needsLocation;
    if (!skipRag) {
      try {
        const queryEmbedding = await embedQuery(cleanMessage);
        const candidates = await vectorSearch(queryEmbedding, 12);
        if (candidates.length > 0) {
          // Booking-aware filtering — scan recent user history so a date
          // mentioned a few turns back ("this weekend") still applies when
          // the user later says "show me villas". Window of 5 prior user
          // turns + current message covers the common conversation depth
          // before history truncation kicks in (MAX_HISTORY_TURNS=12 → 6
          // user turns max).
          const historyText = safeHistory
            .filter((m) => m.role === "user")
            .slice(-5)
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
          // Rank: available first, then by similarity score.
          const ranked = candidates
            .slice()
            .sort((a, b) => {
              if (!!a.partiallyBooked === !!b.partiallyBooked) {
                return (b.score ?? 0) - (a.score ?? 0);
              }
              return a.partiallyBooked ? 1 : -1;
            });
          // Cards and the LLM's grounding context use the SAME set, so the
          // reply text can never name a property the user has no card for.
          // selectCards applies the location filter — see its doc comment.
          cardProperties = selectCards(cleanMessage, ranked);
          const context = buildContext(cardProperties);
          contextBlock = `\n\nRELEVANT PROPERTIES FROM OUR DATABASE:\n${context}\n\nWhen recommending properties, only mention those listed above. Use the property's title (name) only — do NOT echo the ID, URL, or Link field in your text response. The user sees clickable cards below.`;
        }
      } catch (ragErr) {
        console.warn("[chat/route] RAG unavailable, falling back:", (ragErr as Error).message);
      }
    }

    // Pick exactly one mode directive — needsLocation wins because that's the
    // most specific signal (user asked for "near me" without a city). Falls
    // back to the generic conversational directive for greetings/policy/meta,
    // and to nothing in discovery mode where RAG context speaks for itself.
    const modeDirective = needsLocation
      ? LOCATION_REQUIRED_DIRECTIVE
      : isConversationalTurn
      ? CONVERSATIONAL_DIRECTIVE
      : "";
    const systemPrompt =
      BASE_SYSTEM_PROMPT + contextBlock + modeDirective + SAFETY_DIRECTIVE;

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
            const xaiKey = process.env.XAI_API_KEY;
            try {
              await streamOpenAICompatible(
                "https://api.groq.com/openai/v1/chat/completions",
                groqKey,
                "llama-3.3-70b-versatile",
                controller
              );
            } catch (groqErr) {
              // Cascade Groq → xAI if no tokens were emitted yet (i.e. failure
              // happened during the initial fetch / handshake, not mid-stream).
              // Once any text has reached the client we can't roll back, so we
              // surface the error in that case.
              if (assembledReply.length > 0 || !xaiKey) throw groqErr;
              console.warn(
                "[chat/route] Groq failed, cascading to xAI:",
                (groqErr as Error).message?.slice(0, 200)
              );
              await streamOpenAICompatible(
                "https://api.x.ai/v1/chat/completions",
                xaiKey,
                "grok-3-mini",
                controller
              );
            }
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
          // Log structured detail so an operator can tell whether all three
          // providers failed vs a single hop bombed. The user-facing copy
          // stays generic on purpose — leaking provider names to the client
          // gives an attacker free reconnaissance.
          console.error(
            "[chat/route] Stream error (provider=%s, assembled=%d chars):",
            provider,
            assembledReply.length,
            streamErr
          );
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
