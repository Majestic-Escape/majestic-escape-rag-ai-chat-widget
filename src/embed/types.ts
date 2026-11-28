export interface PropertyCardData {
  _id: string;
  title: string;
  propertyType: string;
  address: { city: string; state: string };
  basePrice: number;
  averageRating: number;
  reviewCount: number;
  photos: string[];
  /** absent when the listing has no value */
  guests?: number;
  bedrooms?: number;
  /** Which kind of result this card is. One reply never mixes groups. */
  group?: "match" | "possible" | "alternative";
  /** Why a card is not a plain match: "9 km from Panaji", "not verified: private pool". */
  note?: string;
  /** "available" = returned by a dated search in this reply; "recheck" = it was, when this saved reply was written. */
  availability?: "available" | "recheck";
}

/** A change to the search made by a button, the filter editor or a confirmed draft. Applied by the server
 *  without a model, after the same validation as any other change. */
export interface FilterOp {
  set?: Record<string, unknown>;
  unset?: string[];
  remove?: string[];
  unsupported?: string[];
  soft?: string[];
  reset?: true;
}

/** One requirement of the current search. `op` is sent back as-is when the customer removes it. */
export interface FilterChip {
  label: string;
  op: FilterOp;
}

export interface NumRange { min?: number; max?: number }
/** The search as the server holds it: what the filter editor starts from. */
export interface SearchFilters {
  place?: string;
  guests?: NumRange;
  price?: NumRange;
  bedrooms?: NumRange;
  beds?: NumRange;
  bathrooms?: NumRange;
  propertyType?: string;
  placeType?: "entire" | "room";
  amenitiesAll?: string[];
  amenitiesAny?: string[];
  amenitiesNone?: string[];
  petsAllowed?: true;
  instantBook?: true;
  selfCheckIn?: true;
  cancellation?: string;
  unsupported?: string[];
  soft?: string[];
}

/** What a typed message would change. Nothing is applied until the guest confirms. */
export interface Draft {
  said: string;
  lines: { kind: string; label: string; op: FilterOp }[];
  notes: string[];
}

export type SystemMessageKind = "join" | "handover" | "resolve" | "reopen" | "auto";

export interface Message {
  id: string;
  role: "user" | "model" | "system";
  text: string;
  timestamp: Date;
  isSupport?: boolean;
  serverId?: string;
  clientMessageId?: string;
  authorName?: string | null;
  systemKind?: SystemMessageKind;
  properties?: PropertyCardData[];
  /** The requirements this reply searched with, as removable chips (live replies only — not restored from history). */
  filters?: FilterChip[];
  /** The heading above this reply's cards: "Matches", "Nearby alternatives", … */
  heading?: string | null;
  /** Filters mode: the search after this reply (the editor's starting point). */
  search?: SearchFilters;
  /** Filters mode: a typed message read as a draft, waiting for the guest's confirmation. */
  draft?: Draft;
  /** Filters mode: whether typed messages are drafted by the assistant. */
  controls?: { draft: boolean };
  /** Answers offered as buttons ("Yes, show them" / "No"). */
  quick?: string[];
  /**
   * Support messages from this device that the server hasn't confirmed yet.
   * "sending": waiting for the server; "failed": the server refused it (not
   * stored — `failureReason` says why); "unconfirmed": no answer came, so it
   * may or may not be stored. Absent once the server has it.
   */
  deliveryState?: "sending" | "failed" | "unconfirmed";
  failureReason?: string;
}

export type ChatMode = "ai" | "support";

export interface SupportRating {
  stars: number;
  comment: string | null;
  ratedAt: string;
}

export interface ChatState {
  isOpen: boolean;
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  mode: ChatMode;
}
