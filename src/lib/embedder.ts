import { ObjectId, Db } from "mongodb";
import clientPromise from "./mongodb";

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

// Bump this whenever buildPropertyText changes shape (added fields, reworded prose, etc.)
// catchUpSync re-embeds any property whose stored embeddingVersion < EMBEDDER_VERSION.
export const EMBEDDER_VERSION = 2;

// Searchable property fields. A change to any of these triggers a re-embed.
// Top-level keys; dotted sub-paths (e.g., "address.city") match by their root.
export const EMBED_TRIGGER_FIELDS = new Set<string>([
  "title", "description", "amenities", "basePrice", "address",
  "propertyType", "placeType", "guests", "bedrooms", "beds",
  "bathrooms", "bathroomTypes", "checkinTime", "checkoutTime",
  "selectedRules", "customRules", "occupancy",
  "bookingType", "cancellationType",
  "discounts", "status", "averageRating", "reviewCount",
  "photos",
]);

export function changedFieldsTriggerReembed(changedKeys: string[]): boolean {
  // Match exact key OR top-level dotted key (e.g. "address.city" → "address")
  return changedKeys.some((k) => {
    const top = k.split(".")[0];
    return EMBED_TRIGGER_FIELDS.has(k) || EMBED_TRIGGER_FIELDS.has(top);
  });
}

interface RawProperty {
  _id: ObjectId;
  title?: string;
  description?: string;
  propertyType?: string;
  placeType?: string;
  address?: {
    street?: string;
    district?: string;
    city?: string;
    state?: string;
    pincode?: string;
    country?: string;
  };
  basePrice?: number;
  guests?: number;
  bedrooms?: number;
  beds?: number;
  bathrooms?: number;
  bathroomTypes?: { private?: number; shared?: number; dedicated?: number };
  amenities?: string[];
  selectedRules?: string[];
  customRules?: string[];
  occupancy?: string[];
  bookingType?: { instantBook?: boolean; flashBook?: boolean; manual?: boolean };
  cancellationType?: { moderate?: boolean; flexible?: boolean; strict?: boolean };
  checkinTime?: string;
  checkoutTime?: string;
  averageRating?: number;
  reviewCount?: number;
  discounts?: string[];
  status?: string;
}

interface ReviewSnippet {
  content?: string;
  rating?: number;
}

export function buildPropertyText(p: RawProperty, reviews: ReviewSnippet[] = []): string {
  const parts: string[] = [];

  // Detailed location prose: street + district help "near MG Road" / "in Candolim" queries.
  const fullLocation = [
    p.address?.street,
    p.address?.district,
    p.address?.city,
    p.address?.state,
  ]
    .filter(Boolean)
    .join(", ");
  parts.push(
    `${p.title || "Unnamed property"} — ${p.propertyType || "Stay"}, ${p.placeType || "entire"} in ${fullLocation || "India"}.`
  );
  // Repeat the city/state plainly so vector search sees them clearly when they exist.
  if (p.address?.city || p.address?.state) {
    parts.push(`Located in ${[p.address?.city, p.address?.state].filter(Boolean).join(", ")}, India.`);
  }
  if (p.address?.pincode) parts.push(`PIN code: ${p.address.pincode}.`);

  const capacity = [
    p.guests ? `${p.guests} guests` : null,
    p.bedrooms ? `${p.bedrooms} bedrooms` : null,
    p.beds ? `${p.beds} beds` : null,
    p.bathrooms ? `${p.bathrooms} bathrooms` : null,
  ]
    .filter(Boolean)
    .join(", ");
  if (p.basePrice) parts.push(`Price: ₹${p.basePrice}/night.`);
  if (capacity) parts.push(`Capacity: ${capacity}.`);

  // Bathroom breakdown: searchable for "private bathroom" queries
  const bt = p.bathroomTypes;
  if (bt && (bt.private || bt.shared || bt.dedicated)) {
    const btParts: string[] = [];
    if (bt.private) btParts.push(`${bt.private} private`);
    if (bt.dedicated) btParts.push(`${bt.dedicated} dedicated`);
    if (bt.shared) btParts.push(`${bt.shared} shared`);
    if (btParts.length) parts.push(`Bathroom breakdown: ${btParts.join(", ")}.`);
  }

  if (p.amenities?.length) parts.push(`Amenities: ${p.amenities.join(", ")}.`);

  // Suitable for: families, groups, etc. (occupancy enum).
  if (p.occupancy?.length) {
    const friendly = p.occupancy
      .map((o) => {
        switch (o) {
          case "self-check-in": return "self check-in supported";
          case "me": return "ideal for solo travelers";
          case "family": return "family-friendly";
          case "guests": return "great for groups of guests";
          case "flatmates": return "shared with flatmates";
          default: return o;
        }
      })
      .join(", ");
    parts.push(`Suitable for: ${friendly}.`);
  }

  const bookingTypes: string[] = [];
  if (p.bookingType?.instantBook) bookingTypes.push("Instant Book available");
  if (p.bookingType?.flashBook) bookingTypes.push("Flash Book available");
  if (p.bookingType?.manual) bookingTypes.push("Host approval required");
  if (bookingTypes.length) parts.push(bookingTypes.join("; ") + ".");

  // Cancellation policy: explicit prose for "flexible cancellation" queries.
  const cancel: string[] = [];
  if (p.cancellationType?.flexible) cancel.push("flexible");
  if (p.cancellationType?.moderate) cancel.push("moderate");
  if (p.cancellationType?.strict) cancel.push("strict");
  if (cancel.length) parts.push(`Cancellation policy: ${cancel.join(" or ")}.`);

  if (p.checkinTime) parts.push(`Check-in: ${p.checkinTime}.`);
  if (p.checkoutTime) parts.push(`Check-out: ${p.checkoutTime}.`);

  const ruleParts = [...(p.selectedRules ?? []), ...(p.customRules ?? [])].filter(Boolean);
  if (ruleParts.length) parts.push(`House rules: ${ruleParts.join(", ")}.`);

  if ((p.averageRating ?? 0) > 0) {
    parts.push(`Rated ${p.averageRating}/5 from ${p.reviewCount || 0} reviews.`);
  }

  if (p.discounts?.length) parts.push(`Discounts: ${p.discounts.join(", ")}.`);

  if (p.description) parts.push(`Description: ${p.description}`);

  if (reviews.length > 0) {
    const snippets = reviews
      .filter((r) => r.content?.trim())
      .map((r) => `"${r.content!.trim().substring(0, 160)}" (${r.rating ?? "?"}/5)`)
      .join("; ");
    if (snippets) parts.push(`Guest reviews: ${snippets}`);
  }

  return parts.join(" ");
}

export async function embedSingleText(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const res = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}

async function getDb(): Promise<Db> {
  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  return client.db(dbName);
}

async function fetchRecentReviews(propertyId: ObjectId): Promise<ReviewSnippet[]> {
  const db = await getDb();
  return db
    .collection<ReviewSnippet & { property: ObjectId; hideStatus: string; createdAt: Date }>("reviews")
    .find({ property: propertyId, hideStatus: "accept" }, { projection: { content: 1, rating: 1 } })
    .sort({ createdAt: -1 })
    .limit(3)
    .toArray();
}

/**
 * Re-embeds a property by id. If the property is missing or non-active, the embedding fields
 * are unset so the vector index stops surfacing it. Always uses the raw MongoDB driver — never
 * Mongoose — so server.me's schema layer is not involved.
 */
export async function embedAndSaveProperty(id: ObjectId | string): Promise<void> {
  const db = await getDb();
  const coll = db.collection<RawProperty>("listingproperties");
  const _id = typeof id === "string" ? new ObjectId(id) : id;

  const property = await coll.findOne({ _id });
  if (!property || property.status !== "active") {
    await coll.updateOne(
      { _id },
      { $unset: { embedding: "", embeddingUpdatedAt: "", embeddingVersion: "" } }
    );
    return;
  }

  const reviews = await fetchRecentReviews(_id);
  const text = buildPropertyText(property, reviews);
  const embedding = await embedSingleText(text);

  await coll.updateOne(
    { _id },
    {
      $set: {
        embedding,
        embeddingUpdatedAt: new Date(),
        embeddingVersion: EMBEDDER_VERSION,
      },
    }
  );
}

export async function unsetEmbedding(id: ObjectId): Promise<void> {
  const db = await getDb();
  await db
    .collection("listingproperties")
    .updateOne(
      { _id: id },
      { $unset: { embedding: "", embeddingUpdatedAt: "", embeddingVersion: "" } }
    );
}
