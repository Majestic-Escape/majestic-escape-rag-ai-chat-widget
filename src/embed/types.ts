export interface PropertyCardData {
  _id: string;
  title: string;
  propertyType: string;
  address: { city: string; state: string };
  basePrice: number;
  averageRating: number;
  reviewCount: number;
  photos: string[];
  guests: number;
  bedrooms: number;
  partiallyBooked?: boolean;
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
