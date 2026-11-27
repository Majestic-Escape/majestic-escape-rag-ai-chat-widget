// V1 retrieval logic, copied VERBATIM from src/app/api/chat/route.ts at 9959a00
// (the last version that served customers) so the evaluation can measure the
// old behaviour as a baseline after the route itself moved to the new pipeline.
// Do not edit: it is a measurement reference, not live code.
/* eslint-disable */

export interface PropertyResult {
  _id: string;
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

export function needsLocationAsk(message: string, recentUserMessages: string[]): boolean {
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

export function shouldUseRag(message: string): boolean {
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
export function selectCards(query: string, ranked: PropertyResult[]): PropertyResult[] {
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
