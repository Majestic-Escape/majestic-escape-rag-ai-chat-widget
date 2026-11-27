// Shared shapes for the search pipeline (RAG V2). Pure types and constants only.

/** The closed amenity vocabulary of `listingproperties.amenities` (server.me). */
export const AMENITY_KEYS = [
  "wifi", "free-parking", "air-conditioning", "kitchen", "tv", "fire-extinguisher",
  "workspace", "pool", "first-aid", "washing", "outdoor-dining", "bbq", "lake",
  "beach", "smoke-alarm", "firepit", "patio", "pool-table",
] as const;
export type AmenityKey = (typeof AMENITY_KEYS)[number];

/** A row of `GET /properties/search-properties` — only the fields we read. */
export interface Listing {
  _id: string;
  title?: string;
  propertyType?: string;
  placeType?: string;
  guests?: number;
  bedrooms?: number;
  beds?: number;
  bathrooms?: number;
  amenities?: string[];
  basePrice?: number;
  bookingType?: { instantBook?: boolean; manual?: boolean; flashBook?: boolean };
  cancellationType?: { flexible?: boolean; moderate?: boolean; strict?: boolean };
  selectedRules?: string[];
  occupancy?: string[];
  checkinTime?: string;
  checkoutTime?: string;
  address?: { district?: string; city?: string; state?: string };
  status?: string;
  photos?: string[];
  averageRating?: number;
  reviewCount?: number;
  distanceKm?: number;
}

export interface Range {
  min?: number;
  max?: number;
}

/** What the customer has asked for so far. Every field is a MANDATORY requirement
 *  except `soft`. Stored per identity in `ai_chat_state`. */
export interface SearchState {
  place?: string; // verbatim; resolved by the site's own place search
  checkIn?: string; // YYYY-MM-DD, a calendar date in India
  checkOut?: string; // exclusive
  nights?: number; // a length of stay given before any dates; not a filter
  guests?: Range; // adults + children; infants are not counted (the booking rule)
  bedrooms?: Range;
  beds?: Range;
  bathrooms?: Range;
  price?: Range; // rupees per night, before taxes and fees
  propertyType?: string;
  placeType?: "entire" | "room";
  amenitiesAll?: AmenityKey[];
  amenitiesAny?: AmenityKey[]; // one OR group
  amenitiesNone?: AmenityKey[];
  petsAllowed?: true;
  instantBook?: true;
  selfCheckIn?: true;
  cancellation?: "flexible" | "moderate" | "strict";
  /** Requirements no data field can prove ("private pool"). Never dropped. */
  unsupported?: string[];
  soft?: string[];
  /** Cards of the last reply, in order — "the second one". */
  shownIds?: string[];
  /** Signature of the unverifiable requirements the customer agreed to see past. */
  consentFor?: string;
}

export type ReqStatus = "satisfied" | "unsatisfied" | "unknown" | "unsupported";

export interface ReqResult {
  key: string; // stable id: "guests", "price", "amenity:pool", "unsupported:private pool"
  label: string; // customer wording: "8 guests", "up to ₹10,000 a night"
  status: ReqStatus;
}

export type MatchClass = "confirmed" | "possible" | "excluded";

export interface Evaluated {
  listing: Listing;
  results: ReqResult[];
  cls: MatchClass;
}
