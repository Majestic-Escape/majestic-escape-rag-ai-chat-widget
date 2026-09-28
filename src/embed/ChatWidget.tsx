import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCurrentPathname, getBackendUrl, getAuthToken } from "./utils";
import {
  X,
  Send,
  Loader2,
  Sparkles,
  Headset,
  MessageCircle,
  Search,
  MapPin,
  Calendar,
  PhoneCall,
  HelpCircle,
  CreditCard,
  Star,
  BedDouble,
  Users,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Menu as MenuIcon,
  Compass,
  Heart,
  RotateCcw,
  MessageSquare,
} from "lucide-react";
import { useChat } from "./useChat";
import { useSupportChat, RetryResult } from "./useSupportChat";
import { ComposerField } from "./ComposerField";
import { Message, ChatMode, PropertyCardData } from "./types";

const aiQuickPrompts = [
  { icon: <Search className="w-3.5 h-3.5" />, text: "Find a villa in Goa with a pool" },
  { icon: <MapPin className="w-3.5 h-3.5" />, text: "Suggest a weekend getaway from Mumbai" },
  { icon: <Calendar className="w-3.5 h-3.5" />, text: "What are your cancellation policies?" },
];

const supportQuickPrompts = [
  { icon: <PhoneCall className="w-3.5 h-3.5" />, text: "Request a call back" },
  { icon: <HelpCircle className="w-3.5 h-3.5" />, text: "Issue with my booking" },
  { icon: <CreditCard className="w-3.5 h-3.5" />, text: "Payment or refund query" },
];

// ─── Property Card ─────────────────────────────────────────────────────────────

// ─── Property carousel ─────────────────────────────────────────────────────────
// Horizontal snap carousel of portrait property cards. The centred card sits at
// full opacity/scale; neighbours fade and shrink slightly for a depth effect
// that's tasteful (Airbnb / Spotify-style) without the gimmicky cover-flow tilt.
// Native CSS scroll-snap drives the snapping; an IntersectionObserver tracks
// the centred card so the dots indicator + scale gradient stay in sync.

// Card width is uniform across every viewport — w-72 (288px) × h-80 (320px).
// One big card visible at a time gives the imagery and pricing room to
// breathe and keeps the experience identical on phone, tablet, and desktop.
// scrollByCard() still reads the rendered width at runtime so any future
// resize tweak just works.
const CARD_GAP = 12;

const PropertyCardPortrait: React.FC<{
  property: PropertyCardData;
  index: number;
  total: number;
  isCentered: boolean;
  reduceMotion: boolean;
}> = ({ property, index, total, isCentered, reduceMotion }) => {
  const location = [property.address?.city, property.address?.state]
    .filter(Boolean)
    .join(", ");

  return (
    <a
      href={`/stay/${property._id}`}
      role="group"
      aria-roledescription="slide"
      aria-label={`${index + 1} of ${total}: ${property.title}`}
      className={`
        snap-center shrink-0 w-72 h-80
        bg-white border border-gray-200 rounded-2xl
        overflow-hidden shadow-md hover:shadow-lg group no-underline
        flex flex-col
        ${reduceMotion ? "" : "transition-all duration-300 ease-out"}
        ${reduceMotion ? "" : isCentered ? "scale-100 opacity-100" : "scale-95 opacity-80"}
        hover:-translate-y-0.5 hover:border-primaryGreen
      `}
    >
      {/* Hero image — 60% of card height (≈192px) */}
      <div className="relative h-[60%] bg-gray-100 overflow-hidden">
        {property.photos?.[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={property.photos[0]}
            alt={property.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ease-out"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-lightGreen/30">
            <BedDouble className="w-10 h-10 text-primaryGreen/50" />
          </div>
        )}
        {property.partiallyBooked && (
          <span className="absolute top-2.5 left-2.5 bg-white/95 backdrop-blur text-[11px] font-medium text-red-600 px-2.5 py-0.5 rounded-full border border-red-200 shadow-sm">
            Booked for your dates
          </span>
        )}
        {property.averageRating > 0 && (
          <span className="absolute top-2.5 right-2.5 bg-white/95 backdrop-blur text-[12px] font-semibold text-graphite px-2 py-0.5 rounded-full flex items-center gap-0.5 shadow-sm">
            <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
            {property.averageRating.toFixed(1)}
          </span>
        )}
      </div>

      {/* Body — bottom 40% */}
      <div className="flex flex-col justify-between flex-1 px-3.5 py-3 min-w-0">
        <div>
          <p className="text-[15px] font-semibold text-graphite leading-snug line-clamp-2 group-hover:text-primaryGreen transition-colors">
            {property.title}
          </p>
          <p className="text-[12px] text-gray-500 mt-1 flex items-center gap-1 line-clamp-1">
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            {location || "India"}
          </p>
        </div>
        <div className="flex items-center justify-between gap-1">
          <span className="text-[15px] font-semibold text-primaryGreen whitespace-nowrap">
            ₹{property.basePrice?.toLocaleString("en-IN")}
            <span className="text-[11px] text-gray-500 font-normal">/night</span>
          </span>
          <div className="flex items-center gap-1 text-[12px] text-gray-500 shrink-0">
            <Users className="w-3.5 h-3.5" />
            {property.guests}
            <BedDouble className="w-3.5 h-3.5 ml-1" />
            {property.bedrooms}
          </div>
        </div>
      </div>
    </a>
  );
};

const SeeAllTile: React.FC<{ query: string; index: number; total: number }> = ({
  query,
  index,
  total,
}) => (
  <a
    href={`/stays${query ? `?q=${encodeURIComponent(query)}` : ""}`}
    role="group"
    aria-roledescription="slide"
    aria-label={`${index + 1} of ${total}: See all matching stays`}
    className="snap-center shrink-0 w-72 h-80 rounded-2xl border-2 border-dashed border-primaryGreen/40 bg-lightGreen/20 hover:bg-lightGreen/40 hover:border-primaryGreen flex flex-col items-center justify-center gap-2 text-primaryGreen no-underline transition-all hover:-translate-y-0.5"
  >
    <div className="w-12 h-12 rounded-full bg-primaryGreen/10 flex items-center justify-center group-hover:bg-primaryGreen/20">
      <ArrowRight className="w-6 h-6" />
    </div>
    <span className="text-[15px] font-semibold text-center px-3 leading-tight">
      See all matching stays
    </span>
  </a>
);

const PropertyCarousel: React.FC<{
  properties: PropertyCardData[];
  query?: string;
}> = ({ properties, query = "" }) => {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [centeredIndex, setCenteredIndex] = useState(0);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);

  // Respect prefers-reduced-motion — no scaling/opacity transitions.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduceMotion(mq.matches);
    handler();
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  // Track which card is closest to the carousel's horizontal centre, plus
  // whether the start/end have been reached so the chevron buttons can disable.
  const updateCenter = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    let bestIdx = 0;
    let bestDistance = Infinity;
    Array.from(scroller.children).forEach((child, i) => {
      const r = (child as HTMLElement).getBoundingClientRect();
      const childCenter = r.left + r.width / 2;
      const d = Math.abs(childCenter - midX);
      if (d < bestDistance) {
        bestDistance = d;
        bestIdx = i;
      }
    });
    setCenteredIndex(bestIdx);
    setCanScrollLeft(scroller.scrollLeft > 4);
    setCanScrollRight(
      scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4
    );
  }, []);

  useEffect(() => {
    updateCenter();
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => updateCenter();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateCenter);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updateCenter);
    };
  }, [updateCenter, properties.length]);

  const scrollByCard = (dir: 1 | -1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Read the actual rendered width of the first card so chevron scrolling
    // advances by exactly one card. Cards are now uniformly w-72 (288px)
    // across all viewports; the live read keeps this resilient if the
    // class ever changes again.
    const first = scroller.firstElementChild as HTMLElement | null;
    const width = first ? first.getBoundingClientRect().width : 288;
    scroller.scrollBy({
      left: dir * (width + CARD_GAP),
      behavior: "smooth",
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      scrollByCard(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      scrollByCard(-1);
    }
  };

  const total = properties.length + 1; // +1 for the trailing "see all" tile

  return (
    <div className="relative mt-2 w-full">
      {/* Carousel viewport */}
      <div
        ref={scrollerRef}
        role="region"
        aria-roledescription="carousel"
        aria-label="Suggested stays"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="flex gap-3 overflow-x-auto snap-x snap-mandatory scroll-smooth pb-3 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-primaryGreen rounded-xl [scrollbar-width:thin] [scrollbar-color:rgba(54,98,31,0.25)_transparent] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-primaryGreen/20 [&::-webkit-scrollbar-thumb]:rounded-full"
        style={{ perspective: "1000px" }}
      >
        {properties.map((p, i) => (
          <PropertyCardPortrait
            key={p._id}
            property={p}
            index={i}
            total={total}
            isCentered={i === centeredIndex}
            reduceMotion={reduceMotion}
          />
        ))}
        <SeeAllTile query={query} index={properties.length} total={total} />
      </div>

      {/* Desktop chevron buttons (hidden on mobile, swipe handles it) */}
      <button
        type="button"
        onClick={() => scrollByCard(-1)}
        disabled={!canScrollLeft}
        aria-label="Previous stays"
        className={`hidden md:flex absolute left-0 top-[40%] -translate-y-1/2 -translate-x-1 w-8 h-8 items-center justify-center rounded-full bg-white shadow-md border border-gray-200 hover:border-primaryGreen hover:text-primaryGreen text-graphite transition-all ${
          canScrollLeft ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => scrollByCard(1)}
        disabled={!canScrollRight}
        aria-label="Next stays"
        className={`hidden md:flex absolute right-0 top-[40%] -translate-y-1/2 translate-x-1 w-8 h-8 items-center justify-center rounded-full bg-white shadow-md border border-gray-200 hover:border-primaryGreen hover:text-primaryGreen text-graphite transition-all ${
          canScrollRight ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <ChevronRight className="w-4 h-4" />
      </button>

      {/* Dot indicator */}
      <div className="flex items-center justify-center gap-1.5 mt-1" aria-hidden="true">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`rounded-full transition-all ${
              i === centeredIndex
                ? "w-4 h-1.5 bg-primaryGreen"
                : "w-1.5 h-1.5 bg-gray-300"
            }`}
          />
        ))}
      </div>
    </div>
  );
};

// ─── Message Bubble ─────────────────────────────────────────────────────────────

// ─── Rating Prompt ─────────────────────────────────────────────────────────────

const RatingPrompt: React.FC<{
  onSubmit: (stars: number, comment?: string) => void;
  onSkip: () => void;
  alreadyRated: boolean;
  ratingValue: number;
}> = ({ onSubmit, onSkip, alreadyRated, ratingValue }) => {
  const [hover, setHover] = useState(0);
  const [selected, setSelected] = useState(ratingValue || 0);
  const [comment, setComment] = useState("");

  if (alreadyRated) {
    return (
      <div className="flex flex-col items-center gap-1">
        <p className="text-[12px] text-stone">Thanks for your feedback!</p>
        <div className="flex gap-0.5 text-amber-400">
          {[1, 2, 3, 4, 5].map((n) => (
            <Star
              key={n}
              className={`w-4 h-4 ${n <= ratingValue ? "fill-amber-400" : "fill-transparent text-gray-300"}`}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-[12px] text-graphite font-medium">How was your support experience?</p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onClick={() => setSelected(n)}
            aria-label={`Rate ${n} star${n === 1 ? "" : "s"}`}
            className="p-0.5"
          >
            <Star
              className={`w-6 h-6 transition-colors ${
                (hover || selected) >= n
                  ? "fill-amber-400 text-amber-400"
                  : "fill-transparent text-gray-300"
              }`}
            />
          </button>
        ))}
      </div>
      {selected > 0 && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, 500))}
          placeholder="Anything else you'd like to share? (optional)"
          rows={2}
          className="w-full text-[12px] border border-gray-200 rounded-lg p-2 focus:outline-none focus:border-primaryGreen resize-none"
        />
      )}
      <div className="flex gap-2 w-full">
        <button
          onClick={() => onSkip()}
          className="flex-1 text-[12px] text-stone py-1.5 hover:text-graphite"
        >
          Skip
        </button>
        <button
          onClick={() => selected > 0 && onSubmit(selected, comment.trim() || undefined)}
          disabled={selected === 0}
          className="flex-1 text-[12px] bg-primaryGreen text-white rounded-full py-1.5 hover:bg-brightGreen disabled:opacity-50"
        >
          Submit
        </button>
      </div>
    </div>
  );
};

// ─── Message Bubble ─────────────────────────────────────────────────────────────

// Under a Support message the server hasn't confirmed: "Not sent" (refused —
// not stored) or "Delivery not confirmed" (no answer — it may be stored), with
// Retry and Remove. A retry the server can no longer deduplicate asks first.
// Nothing shows while a message is simply on its way.
const DeliveryStatus: React.FC<{
  message: Message;
  onRetry: (id: string, confirmed?: boolean) => RetryResult;
  onRemove: (id: string) => void;
}> = ({ message, onRetry, onRemove }) => {
  const [confirming, setConfirming] = useState(false);
  const sendAgainRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) sendAgainRef.current?.focus({ preventScroll: true });
  }, [confirming]);
  useEffect(() => {
    if (message.deliveryState === "sending") setConfirming(false);
  }, [message.deliveryState]);

  if (message.deliveryState !== "failed" && message.deliveryState !== "unconfirmed") return null;
  const action =
    "min-h-6 px-1.5 -mx-0.5 rounded font-semibold text-graphite underline underline-offset-2 hover:text-primaryGreen focus-visible:outline focus-visible:outline-2 focus-visible:outline-primaryGreen";

  if (confirming) {
    return (
      <div role="group" aria-label="Send again?" className="mt-1 max-w-[80%] text-right text-[11px] text-stone leading-snug">
        <p>This may already have been delivered. Send it again?</p>
        <div className="flex justify-end gap-2">
          <button
            ref={sendAgainRef}
            type="button"
            className={action}
            onClick={() => {
              setConfirming(false);
              onRetry(message.id, true);
            }}
          >
            Send again
          </button>
          <button type="button" className={action} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const failed = message.deliveryState === "failed";
  return (
    <div className="mt-1 max-w-[80%] flex flex-wrap items-center justify-end gap-x-1 text-[11px] leading-snug">
      <span role="status" className={failed ? "text-red-600" : "text-stone"}>
        {failed ? `Not sent${message.failureReason ? ` — ${message.failureReason}` : ""}` : "Delivery not confirmed"}
      </span>
      <span aria-hidden="true" className="text-stone">·</span>
      <button
        type="button"
        className={action}
        aria-label={failed ? "Retry sending this message" : "Retry this message"}
        onClick={() => {
          if (onRetry(message.id) === "confirm") setConfirming(true);
        }}
      >
        Retry
      </button>
      <span aria-hidden="true" className="text-stone">·</span>
      <button type="button" className={action} aria-label="Remove this message" onClick={() => onRemove(message.id)}>
        Remove
      </button>
    </div>
  );
};

const MessageBubble: React.FC<{
  message: Message;
  onRetry?: (id: string, confirmed?: boolean) => RetryResult;
  onRemove?: (id: string) => void;
}> = ({ message, onRetry, onRemove }) => {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  const formatText = (text: string) =>
    text.split("\n").map((line, i, arr) => (
      <React.Fragment key={i}>
        {line.split(/(\*\*.*?\*\*)/).map((part, j) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={j}>{part.slice(2, -2)}</strong>
          ) : (
            part
          )
        )}
        {i !== arr.length - 1 && <br />}
      </React.Fragment>
    ));

  // System messages (join / handover / resolve / reopen) render as a centred chip.
  if (isSystem) {
    return (
      <div className="flex justify-center w-full animate-fade-in-up my-1">
        <div className="bg-gray-100 text-stone text-[11px] italic px-3 py-1 rounded-full">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col w-full animate-fade-in-up ${isUser ? "items-end" : "items-start"}`}>
      <div className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
        {!isUser && (
          <div
            className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mr-2 mt-1 ${
              message.isSupport ? "bg-blue-100 text-blue-600" : "bg-lightGreen text-primaryGreen"
            }`}
          >
            {message.isSupport ? (
              <Headset className="w-3.5 h-3.5" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
          </div>
        )}
        <div
          className={`
            max-w-[80%] px-4 py-2.5 text-[14px] shadow-sm
            ${
              isUser
                ? "bg-primaryGreen text-white rounded-2xl rounded-tr-sm"
                : "bg-white border border-gray-100 text-graphite rounded-2xl rounded-tl-sm"
            }
          `}
        >
          <div className="leading-relaxed whitespace-pre-wrap break-words">
            {formatText(message.text)}
          </div>
          <div
            className={`text-[10px] mt-1.5 font-medium ${
              isUser ? "text-white/70 text-right" : "text-gray-400 text-left"
            }`}
          >
            {message.timestamp.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </div>
      </div>

      {isUser && message.deliveryState && onRetry && onRemove && (
        <DeliveryStatus message={message} onRetry={onRetry} onRemove={onRemove} />
      )}

      {/* Suggested stays — horizontal snap carousel of portrait cards. */}
      {!isUser && message.properties && message.properties.length > 0 && (
        <div className="ml-8 w-[calc(100%-2rem)]">
          <PropertyCarousel properties={message.properties} />
        </div>
      )}
    </div>
  );
};

// ─── Main Menu Drawer ──────────────────────────────────────────────────────────
// Always-accessible launcher inside the chat panel. Slides down from the top of
// the panel and overlays the messages — input row stays put so the mobile
// keyboard never collides with the menu. Tap a tile → either runs an AI prompt,
// switches to the Support tab, navigates to a route, or starts a fresh
// conversation. Esc / backdrop / X all close the drawer (NOT the chat itself).

type MenuTileAction =
  | { kind: "prompt"; text: string }
  | { kind: "navigate"; href: string }
  | { kind: "support" }
  | { kind: "start-fresh" };

interface MenuTile {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  action: MenuTileAction;
  /** Hide tile when not logged in. */
  requiresLogin?: boolean;
}

interface MenuSection {
  id: string;
  title: string;
  tiles: MenuTile[];
}

// "Conversation" is first so the conversation-control actions (talk to a
// person / start fresh) are visible the instant the menu opens — for a
// logged-in user the later sections would otherwise push them below the fold.
const MENU_SECTIONS: MenuSection[] = [
  {
    id: "conversation",
    title: "Conversation",
    tiles: [
      {
        id: "talk-person",
        label: "Talk to a person",
        description: "Chat with our support team",
        icon: <MessageSquare className="w-4 h-4" />,
        action: { kind: "support" },
        requiresLogin: true,
      },
      {
        id: "start-fresh",
        label: "Start fresh",
        description: "Clear this conversation",
        icon: <RotateCcw className="w-4 h-4" />,
        action: { kind: "start-fresh" },
      },
    ],
  },
  {
    id: "discover",
    title: "Discover",
    tiles: [
      {
        id: "find-stay",
        label: "Find a stay",
        description: "Tell me what you're looking for",
        icon: <Search className="w-4 h-4" />,
        action: { kind: "prompt", text: "Help me find a stay" },
      },
      {
        id: "weekend",
        label: "Plan a weekend",
        description: "Quick getaway ideas",
        icon: <Calendar className="w-4 h-4" />,
        action: { kind: "prompt", text: "Suggest a weekend getaway" },
      },
      {
        id: "browse",
        label: "Browse all stays",
        description: "Open the full catalogue",
        icon: <Compass className="w-4 h-4" />,
        action: { kind: "navigate", href: "/stays" },
      },
    ],
  },
  {
    id: "bookings",
    title: "Bookings",
    tiles: [
      {
        id: "my-bookings",
        label: "My bookings",
        description: "Trips and reservations",
        icon: <BedDouble className="w-4 h-4" />,
        action: { kind: "navigate", href: "/manage-bookings" },
        requiresLogin: true,
      },
      {
        id: "wishlist",
        label: "Wishlist",
        description: "Stays you've saved",
        icon: <Heart className="w-4 h-4" />,
        action: { kind: "navigate", href: "/wishlist" },
        requiresLogin: true,
      },
    ],
  },
  {
    id: "help",
    title: "Help",
    tiles: [
      {
        id: "cancellation",
        label: "Cancellation policy",
        description: "How refunds work",
        icon: <HelpCircle className="w-4 h-4" />,
        action: { kind: "navigate", href: "/cancellation-policy" },
      },
      {
        id: "faqs",
        label: "FAQs",
        description: "Frequently asked questions",
        icon: <HelpCircle className="w-4 h-4" />,
        action: { kind: "navigate", href: "/faq" },
      },
    ],
  },
];

interface MainMenuDrawerProps {
  isOpen: boolean;
  /** Where focus goes when the drawer closes with focus inside it (the menu button). */
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  isLoggedIn: boolean;
  /** False when the ops kill-switch is off — hides every AI-routing tile. */
  aiAvailable: boolean;
  /**
   * False when there is no conversation to clear — anonymous with the
   * assistant off, where the panel is just a sign-in prompt. "Start fresh"
   * there is a dead control: it opens a confirmation, and confirming does
   * nothing visible because there is no AI thread and no support socket.
   * Also false in Support before the customer has written anything — a
   * greeting is all there is to clear.
   */
  canStartFresh: boolean;
  /** Support messages still waiting for the server; clearing drops them. */
  pendingCount: number;
  mode: ChatMode;
  onClose: () => void;
  onPrompt: (text: string) => void;
  onNavigate: (href: string) => void;
  onSwitchToSupport: () => void;
  onStartFresh: () => void;
}

const MainMenuDrawer: React.FC<MainMenuDrawerProps> = ({
  isOpen,
  returnFocusRef,
  isLoggedIn,
  aiAvailable,
  canStartFresh,
  pendingCount,
  mode,
  onClose,
  onPrompt,
  onNavigate,
  onSwitchToSupport,
  onStartFresh,
}) => {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const [confirmStartFresh, setConfirmStartFresh] = useState(false);

  // Esc cancels the start-fresh confirmation if it's up; otherwise closes the
  // drawer (but never the whole chat).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (confirmStartFresh) {
          setConfirmStartFresh(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, confirmStartFresh]);

  // Reset the inline confirmation each time the drawer is reopened.
  useEffect(() => {
    if (!isOpen) setConfirmStartFresh(false);
  }, [isOpen]);

  // Focus follows the drawer: into it when it opens (it is a modal dialog),
  // and back to the menu button when it closes with focus inside — it is
  // inert then, so focus would otherwise drop out of the chat.
  const wasOpenRef = useRef(isOpen);
  useLayoutEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer || isOpen === wasOpenRef.current) return;
    wasOpenRef.current = isOpen;
    if (isOpen) {
      drawer.focus({ preventScroll: true });
    } else if (drawer.contains((drawer.getRootNode() as Document | ShadowRoot).activeElement)) {
      returnFocusRef.current?.focus({ preventScroll: true });
    }
  }, [isOpen, returnFocusRef]);

  const handleTile = (tile: MenuTile) => {
    switch (tile.action.kind) {
      case "prompt":
        onPrompt(tile.action.text);
        onClose();
        break;
      case "navigate":
        onNavigate(tile.action.href);
        onClose();
        break;
      case "support":
        onSwitchToSupport();
        onClose();
        break;
      case "start-fresh":
        setConfirmStartFresh(true);
        break;
    }
  };

  // Visible sections after applying the logged-in and AI-availability filters —
  // and we drop any section that has no tiles left for this user.
  const visibleSections = MENU_SECTIONS.map((s) => ({
    ...s,
    tiles: s.tiles.filter(
      (t) =>
        (!t.requiresLogin || isLoggedIn) &&
        // Every "prompt" tile sends its text straight to the AI. With the
        // assistant disabled those would switch the user to a tab that is no
        // longer rendered and then hit a 403, so drop them rather than leave a
        // dead end in the menu.
        (t.action.kind !== "prompt" || aiAvailable) &&
        // Likewise "start fresh" when there is nothing to clear.
        (t.action.kind !== "start-fresh" || canStartFresh)
    ),
  })).filter((s) => s.tiles.length > 0);

  return (
    <>
      {/* Backdrop — covers the messages below the drawer. Tap to close. */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`absolute inset-0 z-30 bg-graphite/20 transition-opacity duration-200 ${
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* Drawer panel — slides down from the top of the chat panel. Inert
          while closed, so its tiles aren't hidden stops in the Tab order, and
          `invisible` once it has slid away: parked above the panel, its
          shadow used to show as a grey band across the top of the header
          (and its blur layer kept compositing). */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Chatbot menu"
        inert={!isOpen}
        tabIndex={-1}
        className={`
          absolute left-0 right-0 top-0 z-40 max-h-[88%] overflow-y-auto outline-none
          bg-white/98 backdrop-blur-md shadow-xl rounded-t-2xl duration-200 ease-out
          ${
            isOpen
              ? "visible translate-y-0 transition-transform"
              : "invisible -translate-y-full pointer-events-none transition-[transform,visibility]"
          }
        `}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 sticky top-0 bg-white/98 backdrop-blur-md z-10">
          <h3 className="font-semibold text-graphite text-[15px]">Menu</h3>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="p-1.5 hover:bg-gray-100 rounded-full text-gray-500 hover:text-gray-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 flex flex-col gap-4">
          {visibleSections.map((section) => (
            <div key={section.id}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-stone mb-2 px-1">
                {section.title}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {section.tiles.map((tile) => (
                  <button
                    key={tile.id}
                    type="button"
                    onClick={() => handleTile(tile)}
                    className="flex flex-col items-start gap-1.5 rounded-2xl border border-gray-100 bg-white hover:border-primaryGreen hover:shadow-sm transition-all px-3 py-2.5 text-left min-h-[44px]"
                  >
                    <span className="w-7 h-7 rounded-lg bg-lightGreen/40 text-primaryGreen flex items-center justify-center shrink-0">
                      {tile.icon}
                    </span>
                    <span className="text-[12px] font-semibold text-graphite leading-tight">
                      {tile.label}
                    </span>
                    <span className="text-[10px] text-stone leading-tight line-clamp-2">
                      {tile.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Start-fresh confirmation — centred over the whole panel so it's
          always fully visible, never pushed below a scroll fold. Backdrop
          tap or Esc cancels; the inner card stops click propagation. */}
      {confirmStartFresh && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-graphite/40 backdrop-blur-sm p-5 animate-fade-in-up"
          onClick={() => setConfirmStartFresh(false)}
        >
          <div
            role="alertdialog"
            aria-label="Clear this conversation"
            className="w-full max-w-[300px] bg-white rounded-2xl shadow-xl border border-gray-200 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[15px] font-semibold text-graphite mb-1.5">
              Clear this conversation?
            </p>
            <p className="text-[12px] text-stone leading-relaxed mb-4">
              {mode === "support"
                ? "Your support history will still be saved on the server. This only clears the visible thread."
                : "Your AI history is saved on the server — reload anytime to bring it back."}
            </p>
            {mode === "support" && pendingCount > 0 && (
              <p className="text-[12px] font-medium text-red-600 leading-relaxed -mt-2 mb-4">
                {pendingCount === 1
                  ? "1 message hasn't reached support yet and will be discarded."
                  : `${pendingCount} messages haven't reached support yet and will be discarded.`}
              </p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmStartFresh(false)}
                className="flex-1 text-[13px] font-medium px-3 py-2 rounded-full border border-gray-200 hover:bg-gray-50 text-graphite transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onStartFresh();
                  setConfirmStartFresh(false);
                  onClose();
                }}
                className="flex-1 text-[13px] font-medium px-3 py-2 rounded-full bg-primaryGreen text-white hover:bg-brightGreen transition-colors"
              >
                Yes, start fresh
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// ─── Chat Widget ────────────────────────────────────────────────────────────────

// Paths where the chat widget should NOT render. Matched as
// `pathname === p || pathname.startsWith(`${p}/`)`, so siblings like
// `/login-options` aren't caught by `/login` and must be listed explicitly.
// See plan addendum "Chatbot Widget Placement Audit" for the full rationale.
const HIDE_PATH_PREFIXES = [
  // Auth flows (single-task focus)
  "/login",
  "/login-options",
  "/register",
  "/verification",
  "/ver",

  // Account / profile admin pages
  "/account",
  "/profile",

  // Checkout / payment / booking transaction flow
  "/book/stay",
  "/booking-summary",
  "/payment",

  // Focused review writing
  "/rating",
  "/write-a-review",

  // Conflicts with own messaging / contact UIs
  "/messages",
  "/chat",
  "/inbox",
  "/contact_host",

  // Wrong audience: host dashboard, admin
  "/host",
  "/admin",

  // Utility / non-user-facing
  "/upload",
  "/uploads",
];

function shouldHideOnPath(pathname: string): boolean {
  return HIDE_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

// Single, fixed launcher offset across every route. Picked so it clears the
// tallest bottom UI on the consumer site — both the standard bottom nav and
// the sticky "Reserve" bar on /stay/[id] — without per-route gymnastics that
// would make the launcher visually jump as the user navigates.
const LAUNCHER_OFFSET = "bottom-28 md:bottom-6";

// Stacking against the HOST page, not against ourselves.
//
// This bundle is dropped onto pages we don't control, and the host element
// (<majestic-chat-widget>) is display:inline / z-index:auto, so it creates no
// stacking context of its own — our fixed children compete directly with the
// host page's chrome. user.website's header is `fixed ... z-[1002]`, which beat
// the panel's effective z-50 and painted over its top ~38px: on <lg the panel
// sits at y=8 under a 46px-tall header, so the avatar and the minimise/close
// controls were sliced off. The backdrop lost the same fight, which is why the
// header stayed bright white while the rest of the page dimmed.
//
// A floating assistant belongs above host chrome, so we claim the same near-max
// band third-party widgets conventionally use (Intercom sits at 2147483000).
// Keep the backdrop exactly one below the panel: their relative order is what
// makes click-outside-to-close work.
//
// These must stay literal strings — Tailwind's content scanner only emits
// utilities it can find verbatim in src/embed/**.
const Z_BACKDROP = "z-[2147483000]";
const Z_PANEL_STACK = "z-[2147483001]";

// Opening and closing. Closing is quicker, so it feels immediate. While the
// panel fades out nothing inside it changes — no reconnect status, no layout
// switch, no drawer sliding away — and whatever has to be reset is reset once
// it is gone, so the next open starts clean instead of correcting itself on
// screen. Keep in step with the `duration-200` of the closed states below.
const PANEL_EXIT_MS = 200;
// Resets wait until the fade has surely finished — its last frame can land a
// little after PANEL_EXIT_MS, and a reset in it would show.
const PANEL_GONE_MS = PANEL_EXIT_MS + 150;

// An on-screen keyboard takes at least this much height off the visual
// viewport; the browser toolbars that slide in and out take less.
const KEYBOARD_MIN_PX = 150;

// A support (re)connect quicker than this doesn't show "Connecting…". Every
// open reconnects, and an ordinary one shouldn't flash the header: measured
// from India against production, the socket opens 0.8–2.3 s after the tap
// (connected shortly after). A connection that fails still shows the
// "Couldn't reach support" banner as soon as the attempt errors.
const CONNECTING_GRACE_MS = 3000;

// Within this of the end of the conversation, the reader is following along
// and the list sticks to its end when it changes height; further up they are
// reading back and the list is left where it is.
const FOLLOWING_PX = 24;

// A field of the panel has focus: the message box, or the rating's comment.
function isEditingIn(panel: HTMLElement | null): boolean {
  if (!panel) return false;
  const active = (panel.getRootNode() as Document | ShadowRoot).activeElement;
  return (
    !!active &&
    panel.contains(active) &&
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
  );
}

export const ChatWidget: React.FC = () => {
  const pathname = useCurrentPathname();
  const hidden = shouldHideOnPath(pathname);

  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<ChatMode>("ai");
  const [inputValue, setInputValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // Re-checked when the panel opens; covers logout-mid-session.
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  // Ops kill-switch, read from /api/chat/config. `null` = not yet known.
  //
  // This used to default to "available until proven otherwise", which made the
  // AI tab — greeting, quick prompts and all — flash on screen for the few
  // hundred ms before the config response landed, even with the switch off.
  // Reloading and opening the panel immediately reproduced it every time.
  //
  // It now fails CLOSED: nothing AI-related renders until the answer is known.
  // The cost is the mirror case (assistant on, config still in flight, so the
  // tab appears a moment late) which is strictly the better failure — a missing
  // tab that arrives is a non-event, a forbidden tab that appears is not.
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const {
    aiMessages,
    isLoading: aiLoading,
    error: aiError,
    aiDisabled,
    sendMessage: sendAi,
    initChat: initAi,
    resetAiMessages,
    aiHistoryReady,
    forgetAi,
  } = useChat();
  // What a refused Support message may go back into: the message box, when
  // the Support tab is showing and the box is empty — never over something
  // new being typed, never into the assistant's box. Read when the refusal
  // arrives, so it's a ref kept current by the render.
  const composerForRestoreRef = useRef({ empty: true, support: false });
  const support = useSupportChat({
    restoreToComposer: (text) => {
      const composer = composerForRestoreRef.current;
      if (!composer.support || !composer.empty) return false;
      setInputValue(text);
      return true;
    },
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const insetProbeRef = useRef<HTMLSpanElement>(null); // reads env(safe-area-inset-bottom)
  const launcherRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Which tabs the user may actually see.
  //   configResolved   — /api/chat/config has answered; until then we know
  //     nothing and must not guess in the assistant's favour
  //   aiAvailable      — strictly `=== true`. Anything else (unknown, off,
  //     failed lookup) hides every AI surface.
  //   supportAvailable — Support has always required a logged-in identity
  //   needsLoginForSupport — AI off AND anonymous: the one combination that
  //     leaves nothing usable, so it gets an explicit sign-in call to action
  //     instead of an empty panel. It reveals nothing about the assistant.
  //     Deliberately requires configResolved, so the sign-in prompt doesn't
  //     flash at a logged-out visitor while the assistant is actually on.
  const configResolved = aiEnabled !== null;
  const aiAvailable = aiEnabled === true;
  const supportAvailable = isLoggedIn;
  const needsLoginForSupport = configResolved && !aiAvailable && !supportAvailable;
  // Render the segmented control whenever at least one tab exists. This
  // deliberately preserves the original behaviour for every AI-on case: an
  // anonymous visitor has always seen the bar with a lone "AI Assistant"
  // button. Only the AI-off-and-anonymous case drops it entirely, because then
  // there is genuinely nothing to switch between and the sign-in prompt covers
  // the panel instead.
  // Nothing renders in the tab row until the answer is in — otherwise the very
  // frames this fix exists to remove would still show a lone "AI Assistant".
  const showModeTabs = configResolved && (aiAvailable || supportAvailable);

  // What the UI should actually render, as opposed to what `mode` state happens
  // to hold right now.
  //
  // `mode` defaults to "ai" and is corrected to "support" by an effect once the
  // kill-switch answer arrives. Effects run AFTER paint, so there was exactly
  // one frame where configResolved was already true but mode was still "ai" —
  // long enough to render the "Majestic AI" header, the "Ask AI to find
  // stays..." placeholder and the AI disclaimer. Reproduced at 375, 390, 414
  // and 1440px: one frame each, every time.
  //
  // Deriving it removes the ordering dependency entirely: when the assistant is
  // unavailable there is no sequence of renders that can show AI chrome,
  // regardless of when the effect runs. The effect below still syncs the state
  // so `setMode` callers stay coherent, but nothing visual depends on it.
  const effectiveMode: ChatMode = aiAvailable ? mode : "support";

  // Show only the active tab's history; AI from local hook, Support from Socket.IO hook.
  const messages = effectiveMode === "ai" ? aiMessages : support.messages;
  const isLoading = effectiveMode === "ai" ? aiLoading : support.isLoading;
  const error = effectiveMode === "ai" ? aiError : support.error;
  const hasUserMessage = messages.some((m) => m.role === "user");
  composerForRestoreRef.current = { empty: !inputValue.trim(), support: effectiveMode === "support" };

  // Keep the end of the conversation in view. `fromBottom` is how far the
  // reader is from the end: 0 while following along, more once they scroll up
  // to read. A new message scrolls to the end — gliding for one message,
  // jumping for a whole history or a tab switch, which would otherwise scroll
  // through all of it on open. When the list changes height (the keyboard
  // opening or closing, the header folding, the typing indicator) a reader
  // following along stays at the end, as in a native chat app; one reading
  // back is left alone (the layout effect after the visual viewport one).
  // Scrolling the list itself, not scrollIntoView, which can also pan the
  // page on iOS.
  const fromBottomRef = useRef(0);
  const glideUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const listHeightRef = useRef(0); // the list height fromBottom was measured at
  const lastListRef = useRef({ mode: effectiveMode, count: 0 });

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const list = messagesScrollRef.current;
    if (!list) return;
    fromBottomRef.current = 0;
    lastScrollTopRef.current = list.scrollTop;
    glideUntilRef.current = behavior === "smooth" ? performance.now() + 1000 : 0;
    list.scrollTo({ top: list.scrollHeight, behavior });
  }, []);

  const onMessagesScroll = useCallback(() => {
    const list = messagesScrollRef.current;
    if (!list) return;
    // The list has changed height and the browser has moved it (WebKit clamps
    // before our ResizeObserver runs): that isn't the reader either — the
    // observer re-anchors from where they were.
    if (list.clientHeight !== listHeightRef.current && typeof ResizeObserver !== "undefined") return;
    const top = list.scrollTop;
    // A glide to the end fires scroll events on its way down; those aren't the
    // reader leaving the end. Scrolling up is, even mid-glide.
    const gliding = performance.now() < glideUntilRef.current && top >= lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    if (gliding) return;
    glideUntilRef.current = 0;
    fromBottomRef.current = Math.max(0, list.scrollHeight - top - list.clientHeight);
  }, []);

  // Before paint: a history that has just arrived is never shown from its top first.
  useLayoutEffect(() => {
    const last = lastListRef.current;
    const jump =
      last.mode !== effectiveMode || last.count === 0 || Math.abs(messages.length - last.count) > 2;
    lastListRef.current = { mode: effectiveMode, count: messages.length };
    scrollToEnd(jump ? "auto" : "smooth");
  }, [messages, isLoading, effectiveMode, scrollToEnd]);

  // Close the menu when the entire chat panel closes — otherwise reopening
  // the chat would surface yesterday's open menu. Once the panel has faded
  // out, so the drawer doesn't slide away on a closing panel.
  useEffect(() => {
    if (isOpen) return;
    const t = setTimeout(() => setMenuOpen(false), PANEL_GONE_MS);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Whose chats the panel holds. The site signs people in and out without
  // reloading the page, and the panel keeps its conversations while closed
  // so reopening doesn't flash an empty state — so when a signed-in person
  // has signed out (or someone else has signed in) since the last open, their
  // conversations and draft are dropped here, before anything is painted. A
  // guest who signs in keeps what they asked as a guest: that thread belongs
  // to this device, which anyone on it can already open.
  const identityRef = useRef<string | null>(null);
  const forgetSupport = support.forget;
  useLayoutEffect(() => {
    if (!isOpen) return;
    const identity = getAuthToken() ?? "guest";
    const previous = identityRef.current;
    if (previous !== null && previous !== "guest" && previous !== identity) {
      forgetSupport();
      forgetAi();
      setInputValue("");
    }
    identityRef.current = identity;
  }, [isOpen, forgetSupport, forgetAi]);

  // AI greeting on open (Support greeting comes from server when Socket.IO joins).
  // NOTE: we deliberately DO NOT autofocus the input here — auto-focus opens
  // the mobile keyboard immediately, which jolts the panel layout and feels
  // intrusive when a user just taps the chat icon. Users tap the input when
  // they're ready to type.
  useEffect(() => {
    if (isOpen && mode === "ai" && aiAvailable) initAi("ai");
  }, [isOpen, mode, aiAvailable, initAi]);

  // Read the ops kill-switch on MOUNT, not on open.
  //
  // Fetching it when the panel opened meant the request and the user's click
  // raced: reload, tap the launcher immediately, and the panel rendered before
  // the answer arrived. Starting at mount gives it the whole time between page
  // load and the first click — normally seconds — so by the time anyone opens
  // the widget the state is already settled. One request per page load, still
  // no polling.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/chat/config`, {
          cache: "no-store",
        });
        if (!res.ok) {
          // Can't confirm it's on, so treat it as off. Fail closed: a missing
          // tab is recoverable, a forbidden one is not.
          if (!cancelled) setAiEnabled(false);
          return;
        }
        const data = await res.json();
        if (!cancelled) setAiEnabled(data?.aiEnabled === true);
      } catch {
        // Unreachable config → same reasoning: fail closed. The server would
        // refuse the request anyway, so showing the tab could only mislead.
        if (!cancelled) setAiEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: no `isOpen` dependency, so opening and closing the panel
    // never re-races this.
  }, []);

  // A 403 from /api/chat means ops flipped the switch mid-session (the bundle
  // is cached up to 5 min, so an already-open tab can lag the config). Correct
  // the UI immediately rather than waiting for a reload.
  useEffect(() => {
    if (aiDisabled) setAiEnabled(false);
  }, [aiDisabled]);

  // Never leave the user parked on a tab that is no longer rendered.
  // Waits for `configResolved`: while the answer is still unknown `aiAvailable`
  // is false, and without this guard we'd flip everyone to Support on mount and
  // then leave them there even when the assistant turns out to be enabled.
  useEffect(() => {
    if (configResolved && !aiAvailable && mode === "ai") setMode("support");
  }, [configResolved, aiAvailable, mode]);

  // Re-detect login when the panel opens. Anonymous users see only AI Assistant.
  // Before paint: `isLoggedIn` starts false, so a signed-in visitor's first
  // open drew the "Sign in" prompt (assistant off) for a frame otherwise.
  useLayoutEffect(() => {
    if (!isOpen) return;
    if (typeof window === "undefined") return;
    const raw = localStorage.getItem("token") || localStorage.getItem("authToken");
    let token: string | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        token = typeof parsed === "string" ? parsed : raw;
      } catch {
        token = raw;
      }
    }
    const loggedIn = !!token;
    setIsLoggedIn(loggedIn);
    // If user landed on Support tab but isn't logged in, send them back to AI —
    // but only when the AI tab actually exists. With the kill-switch off there
    // is no AI tab to fall back to, and bouncing them there would strand them
    // on a hidden tab. That case renders the sign-in prompt instead.
    if (!loggedIn && mode === "support" && aiAvailable) setMode("ai");
  }, [isOpen, mode, aiAvailable]);

  // Connect/disconnect the support socket only when the Support tab is active
  // and the panel is open. Depend on the STABLE connect/disconnect callbacks —
  // not the whole `support` object, which is a fresh reference on every render.
  // Using `support` here re-ran the effect each render; paired with the old
  // connect() guard that spawned a socket whenever one wasn't fully connected,
  // it stormed the browser with WebSockets ("Insufficient resources").
  const { connect: connectSupport, disconnect: disconnectSupport } = support;
  useEffect(() => {
    // `supportAvailable` matters now that the kill-switch can leave an
    // anonymous user sitting on the Support tab. Previously that was
    // impossible (they were always bounced to AI), so an unauthenticated
    // socket connect could never be attempted. Without this guard the widget
    // would retry a doomed handshake for every logged-out visitor.
    if (isOpen && mode === "support" && supportAvailable) {
      connectSupport();
      return;
    }
    if (isOpen) {
      disconnectSupport();
      return;
    }
    // Closing: hang up once the panel has faded out. Hanging up at once
    // flipped the fading header to "Connecting…" and dimmed the message box.
    // Reopening within the fade keeps the same socket.
    const t = setTimeout(disconnectSupport, PANEL_GONE_MS);
    return () => clearTimeout(t);
  }, [isOpen, mode, supportAvailable, connectSupport, disconnectSupport]);

  // "Connecting…" only for a (re)connect that takes a while; see
  // CONNECTING_GRACE_MS. Timed per stretch the Support tab is offline, so a
  // switch from the AI tab gets the grace too; left as it is while the panel
  // is closed, so a fading header doesn't change.
  const supportOffline = effectiveMode === "support" && !support.isConnected;
  const [slowConnect, setSlowConnect] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    if (!supportOffline) {
      setSlowConnect(false);
      return;
    }
    const t = setTimeout(() => setSlowConnect(true), CONNECTING_GRACE_MS);
    return () => clearTimeout(t);
  }, [isOpen, supportOffline]);

  // The site can take the visitor to a page without the chat while it's open
  // — to sign-in when a session expires, for one. Close it, or it would come
  // back already open (skipping the check above), possibly for the next
  // person to sign in.
  useEffect(() => {
    if (hidden) setIsOpen(false);
  }, [hidden]);

  // Browser-back closes the panel on mobile + tablet only. Pushes a sentinel
  // history entry when the panel opens; popping it (via the system back gesture
  // or a swipe-back trackpad on tablet) closes the panel without leaving the
  // host page. If the user closes via the X / backdrop / Esc, the cleanup
  // consumes the sentinel so back doesn't replay an empty state. Wrapped in
  // try/catch so sandboxed iframes that block pushState don't throw.
  useEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 1023px)");
    if (!mql.matches) return;
    type Sentinel = { __majesticChatOpen: true };
    const SENTINEL: Sentinel = { __majesticChatOpen: true };
    let sentinelLive = false;
    try {
      history.pushState(SENTINEL, "");
      sentinelLive = true;
    } catch {
      /* sandboxed context — no-op gracefully */
    }
    const onPop = () => {
      sentinelLive = false;
      setIsOpen(false);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (
        sentinelLive &&
        history.state &&
        (history.state as Partial<Sentinel>).__majesticChatOpen
      ) {
        try {
          history.back();
        } catch {
          /* ignore */
        }
      }
    };
  }, [isOpen]);

  // Lock body + html scroll while the chat is open on mobile/tablet (≤ lg).
  // `overflow: hidden` alone is not enough — on iOS Safari and on Android
  // Chrome with `interactive-widget: overlays-content` (the default), the user
  // can still drag the page content behind the panel when the on-screen
  // keyboard is open, which scrolls the host page out from under the floating
  // panel. The hardened pattern: stash the current scroll position, then
  // pin the body with `position: fixed; top: -scrollY; width: 100%`, which
  // visually freezes the page. On cleanup we restore the scroll position so
  // the host page is exactly where the user left it.
  useEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 1023px)");
    let lockedScrollY = 0;
    let isLocked = false;
    const apply = () => {
      const shouldLock = mql.matches;
      if (shouldLock && !isLocked) {
        lockedScrollY = window.scrollY;
        document.body.style.position = "fixed";
        document.body.style.top = `-${lockedScrollY}px`;
        document.body.style.left = "0";
        document.body.style.right = "0";
        document.body.style.width = "100%";
        document.body.style.overflow = "hidden";
        document.documentElement.style.overflow = "hidden";
        document.body.style.overscrollBehavior = "contain";
        isLocked = true;
      } else if (!shouldLock && isLocked) {
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.left = "";
        document.body.style.right = "";
        document.body.style.width = "";
        document.body.style.overflow = "";
        document.documentElement.style.overflow = "";
        document.body.style.overscrollBehavior = "";
        window.scrollTo(0, lockedScrollY);
        isLocked = false;
      }
    };
    apply();
    mql.addEventListener("change", apply);

    // Belt-and-suspenders: even with `position: fixed` on body, iOS Safari
    // and Android Chrome still let touchmove scroll the page when the user
    // drags on a non-scrollable element (the panel header, the input
    // wrapper, the backdrop). We block touchmove globally and only allow it
    // inside the messages list so chat scrolling still works. `passive:
    // false` is required to call preventDefault.
    const preventTouchScroll = (e: TouchEvent) => {
      if (!mql.matches) return;
      const path = e.composedPath();
      const messagesEl = messagesScrollRef.current;
      if (messagesEl && path.includes(messagesEl)) return;
      e.preventDefault();
    };
    document.addEventListener("touchmove", preventTouchScroll, { passive: false });

    return () => {
      mql.removeEventListener("change", apply);
      document.removeEventListener("touchmove", preventTouchScroll);
      if (isLocked) {
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.left = "";
        document.body.style.right = "";
        document.body.style.width = "";
        document.body.style.overflow = "";
        document.documentElement.style.overflow = "";
        document.body.style.overscrollBehavior = "";
        window.scrollTo(0, lockedScrollY);
      }
    };
  }, [isOpen]);

  // Track the visual viewport on mobile/tablet so the panel can shrink when
  // the on-screen keyboard opens. `position: fixed` on iOS/Android anchors to
  // the layout viewport (which doesn't shrink with the keyboard), so without
  // this, the panel keeps its full height and iOS auto-scrolls the focused
  // input into view — which drags the header off-screen. We expose the
  // visible-area height as `--mc-vvh` on the host element; the panel reads it
  // via `max-lg:h-[calc(var(--mc-vvh,100dvh)-16px)]`. Desktop ignores the var
  // because `lg:h-[760px]` wins inside the `min-width: 1024px` media query.
  //
  // The same reading decides whether the panel is in its typing layout
  // (`data-typing`): WhatsApp-style — edge to edge, a one-row header, no tab
  // strip or footer — so the conversation keeps the room between the header
  // and the keyboard. It is on while a field of the panel has focus and the
  // visible area has lost at least a keyboard's height: against its height
  // with no field focused (every browser), or against the layout viewport,
  // which the keyboard doesn't shrink on Chrome/Safari (covers rotating with
  // the keyboard up). A hardware keyboard takes no height, so no typing
  // layout for it. Like the size, it is set on the element rather than
  // through React state, so both change in the same frame and nothing
  // re-renders; the `group-data-[typing]/panel:` classes do the rest. The
  // list keeps its bottom anchored through the change (the layout effect
  // below), so the latest message stays just above the field.
  //
  // A layout effect, so the first frame of an open is already sized right.
  // On close the panel is frozen as it is for its fade-out, then reset.
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    clearTimeout(settleTimerRef.current); // reopened mid-fade: carry on from here
    const mql = window.matchMedia("(max-width: 1023px)");
    const vv = window.visualViewport;
    const host = document.querySelector("majestic-chat-widget") as HTMLElement | null;
    const panel = panelRef.current;
    const insetProbe = insetProbeRef.current;
    if (!host || !vv || !panel) return;
    const readInset = () => (insetProbe ? parseFloat(getComputedStyle(insetProbe).paddingBottom) || 0 : 0);
    let restingHeight = 0;
    let restingWidth = window.innerWidth;
    let restingInset = readInset();
    const update = () => {
      let keyboardUp = false;
      if (mql.matches) {
        const height = vv.height;
        // a new width (rotating, resizing) has a resting height of its own
        if (window.innerWidth !== restingWidth) {
          restingWidth = window.innerWidth;
          restingHeight = height;
        }
        const editing = isEditingIn(panel);
        if (!editing || height > restingHeight) restingHeight = height;
        keyboardUp =
          editing &&
          (restingHeight - height >= KEYBOARD_MIN_PX || window.innerHeight - height >= KEYBOARD_MIN_PX);
        // Chrome on Android draws under the navigation bar here (the site's
        // viewport-fit=cover) and reports the bar as a bottom safe-area
        // inset. With the keyboard up it drops that inset yet still counts
        // the bar in the visual viewport, which then reaches that far behind
        // the keyboard — 24px on a Pixel, enough to hide the message box's
        // lower edge. Take off whatever inset the keyboard made disappear.
        // (iOS keeps its inset while typing, and its viewport is right.)
        const inset = readInset();
        if (!keyboardUp) restingInset = inset;
        const behindKeyboard = keyboardUp ? Math.max(0, restingInset - inset) : 0;
        host.style.setProperty("--mc-vvh", `${height - behindKeyboard}px`);
        // `offsetTop` shifts when iOS/Android moves the visual viewport down
        // to keep the focused input visible while the keyboard is up. Pinning
        // the panel's top to that offset (plus the 8 px margin) keeps the
        // header and panel inside the visible area instead of being scrolled
        // off behind the URL/status bar at the top of the layout viewport.
        host.style.setProperty("--mc-vvtop", `${vv.offsetTop}px`);
      } else {
        host.style.removeProperty("--mc-vvh");
        host.style.removeProperty("--mc-vvtop");
      }
      panel.toggleAttribute("data-typing", keyboardUp);
    };
    update();
    // Safari fires `scroll` (not `resize`) when the keyboard opens on input
    // focus; Android Chrome fires `resize`. Listen to both for cross-OS cover.
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    mql.addEventListener("change", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      mql.removeEventListener("change", update);
      settleTimerRef.current = setTimeout(() => {
        host.style.removeProperty("--mc-vvh");
        host.style.removeProperty("--mc-vvtop");
        panel.removeAttribute("data-typing");
      }, PANEL_GONE_MS);
    };
    // `hidden`: the panel is a new element after the widget comes back on a route
  }, [isOpen, hidden]);
  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  // A reader following along stays at the end when the list changes height (see fromBottomRef).
  // After the effect above, so an open is anchored at its final size — the
  // panel may have been reset to another size while it was closed.
  useLayoutEffect(() => {
    const list = messagesScrollRef.current;
    if (!isOpen || !list) return;
    const anchor = () => {
      listHeightRef.current = list.clientHeight;
      if (fromBottomRef.current <= FOLLOWING_PX) {
        fromBottomRef.current = 0;
        list.scrollTop = list.scrollHeight - list.clientHeight;
      } else {
        // reading back: the view stays where it is, as the browser keeps it
        fromBottomRef.current = Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight);
      }
    };
    anchor();
    if (typeof ResizeObserver === "undefined") return;
    // Called after layout and before paint: a new size is never shown unanchored.
    const observer = new ResizeObserver(() => {
      if (list.clientHeight !== listHeightRef.current) anchor();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [isOpen, hidden]);

  // Focus follows the panel: into it when it opens (the panel itself, not the
  // message box, which would pop the phone keyboard), and off it when it
  // closes — never left on a hidden control. Back to the launcher after a
  // keyboard close (Esc, or Enter/Space on the close button); after a tap,
  // click or Back gesture it's just released, since moving it from the
  // message box would light the launcher's keyboard focus ring.
  const wasOpenRef = useRef(false);
  const closedByKeyboardRef = useRef(false);
  useLayoutEffect(() => {
    if (isOpen === wasOpenRef.current) return;
    wasOpenRef.current = isOpen;
    const panel = panelRef.current;
    if (!panel) return;
    if (isOpen) {
      panel.focus({ preventScroll: true });
      return;
    }
    const active = (panel.getRootNode() as Document | ShadowRoot).activeElement;
    if (active instanceof HTMLElement && panel.contains(active)) {
      if (closedByKeyboardRef.current) launcherRef.current?.focus({ preventScroll: true });
      else active.blur();
    }
    closedByKeyboardRef.current = false;
  }, [isOpen]);

  // The message box stays editable while a reply streams in or support
  // (re)connects — disabling it dropped its focus, which closed the phone
  // keyboard after every message. Only sending waits; the text stays put.
  const canSend = !isLoading && !supportOffline;
  const showConnecting = supportOffline && slowConnect;

  const handleSend = (e?: React.FormEvent, overrideText?: string) => {
    e?.preventDefault();
    const textToSend = overrideText ?? inputValue;
    if (!textToSend.trim() || !canSend) return;
    // effectiveMode, not mode: while the assistant is unavailable `mode` can
    // still read "ai" for a frame, and routing a send down the AI path there
    // would fire a request the server is only going to 403 anyway.
    let sent = true;
    if (effectiveMode === "ai") {
      sendAi(textToSend, "ai");
    } else {
      sent = support.sendMessage(textToSend);
    }
    // Clear only what was sent: a quick prompt leaves the draft alone, and a
    // message support couldn't take yet stays in the box to send again.
    if (sent && overrideText === undefined) setInputValue("");
  };

  // Esc closes the chat, unless the menu is up — it closes itself first —
  // and doesn't go on to the page (a sheet under the chat would close too).
  // Tab stays in the chat while it's open: it's modal, its backdrop covers
  // the page, and Esc wouldn't work from the page behind it.
  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (e.key === "Tab" && panel) {
      const stops = Array.from(
        panel.querySelectorAll<HTMLElement>('button, a[href], textarea, input, select, [tabindex]:not([tabindex="-1"])')
      ).filter(
        (el) =>
          !el.closest("[inert]") &&
          !(el as HTMLButtonElement).disabled &&
          el.getClientRects().length > 0 &&
          getComputedStyle(el).visibility !== "hidden"
      );
      if (!stops.length) return;
      const active = (panel.getRootNode() as Document | ShadowRoot).activeElement;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key !== "Escape" || e.nativeEvent.isComposing || menuOpen) return;
    e.stopPropagation();
    closedByKeyboardRef.current = true;
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Hide widget on excluded routes (login, host dashboard, checkout, etc.).
  // Hooks above must run unconditionally so this `return` stays after them.
  if (hidden) return null;

  return (
    <>
      {/* Backdrop — visible (semi-opaque) on mobile/tablet for the focused-
          modal feel; transparent on desktop but still intercepts clicks so
          tapping anywhere outside the panel closes it on every viewport.
          `touch-none` blocks touch-scroll on the backdrop itself so the host
          page can't scroll when the user drags from outside the panel toward
          its edge. Always mounted, fading in and out with the panel: it used
          to vanish in one frame on close while the panel was still fading.
          `invisible` once faded, so it neither paints nor catches taps. */}
      <div
        onClick={() => setIsOpen(false)}
        className={`fixed inset-0 ${Z_BACKDROP} touch-none bg-black/50 backdrop-blur-sm lg:bg-transparent lg:backdrop-blur-none ${
          isOpen
            ? "visible opacity-100 transition-opacity duration-300 ease-out"
            : "invisible opacity-0 pointer-events-none transition-[opacity,visibility] duration-200 ease-in"
        }`}
        aria-hidden="true"
      />

      {/* `pointer-events-none` here, `-auto` on whichever child is showing:
          this box stays the launcher's size, and must not catch the taps
          meant for the backdrop around it while the panel is open. */}
      <div className={`fixed ${LAUNCHER_OFFSET} right-4 md:right-6 ${Z_PANEL_STACK} flex flex-col items-end font-poppins pointer-events-none`}>
      {/* Chat Window — kept at its open-target position in both states so the
          transition only animates transform + opacity (which CSS can interpolate
          smoothly). Toggling between `absolute bottom-0 right-0` and `fixed
          inset-2` would snap layout instantly, which produced the "moves down,
          then opens" jank users reported. Above the launcher (z-10), which
          fades out underneath it. Closed, it is `invisible` once faded and
          `inert`, so its controls are out of the Tab order; `visibility` is
          only transitioned on the way out, so an opening panel is visible —
          and focusable — at once. While typing on a
          phone it goes edge to edge (`data-typing`) — a single snap with the
          keyboard's own resize, nothing animated on top of it. `data-typing`
          is set by the visual-viewport effect, never by React. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mc-chat-title"
        aria-hidden={!isOpen}
        inert={!isOpen}
        tabIndex={-1}
        onKeyDown={handlePanelKeyDown}
        className={`
          group/panel fixed z-10
          left-2 right-2 top-[calc(var(--mc-vvtop,0px)+8px)]
          max-lg:h-[calc(var(--mc-vvh,100dvh)-16px)]
          data-[typing]:left-0 data-[typing]:right-0 data-[typing]:top-[var(--mc-vvtop,0px)]
          data-[typing]:max-lg:h-[var(--mc-vvh,100dvh)] data-[typing]:rounded-none data-[typing]:border-transparent
          data-[typing]:pl-[env(safe-area-inset-left)] data-[typing]:pr-[env(safe-area-inset-right)]
          lg:inset-auto lg:bottom-24 lg:right-6 lg:top-auto
          lg:w-[400px] lg:h-[760px] lg:max-h-[86vh] lg:max-w-[calc(100vw-2rem)]
          bg-white shadow-floating rounded-2xl border border-gray-200 outline-none
          flex flex-col overflow-hidden origin-bottom-right
          ${
            isOpen
              ? "visible opacity-100 scale-100 translate-y-0 pointer-events-auto transition-[opacity,transform] duration-300 ease-out"
              : "invisible opacity-0 scale-95 translate-y-4 motion-reduce:scale-100 motion-reduce:translate-y-0 pointer-events-none transition-[opacity,transform,visibility] duration-200 ease-in"
          }
        `}
      >
        <span
          ref={insetProbeRef}
          aria-hidden="true"
          className="absolute w-0 h-0 overflow-hidden invisible pointer-events-none pb-[env(safe-area-inset-bottom)]"
        />

        {/* Main menu drawer — overlays the messages when open. Sits above the
            header z-stack so it visually covers everything. */}
        <MainMenuDrawer
          isOpen={menuOpen}
          returnFocusRef={menuButtonRef}
          isLoggedIn={isLoggedIn}
          aiAvailable={aiAvailable}
          // Anonymous with the assistant off has neither an AI thread nor a
          // support socket, so there is genuinely nothing to reset.
          canStartFresh={!needsLoginForSupport && (effectiveMode !== "support" || hasUserMessage)}
          pendingCount={support.pendingCount}
          mode={mode}
          onClose={() => setMenuOpen(false)}
          onPrompt={(text) => {
            // Defence in depth: the drawer already hides prompt tiles when the
            // assistant is off, so this should be unreachable. Belt-and-braces
            // because the alternative is silently switching to a hidden tab.
            if (!aiAvailable) return;
            if (mode !== "ai") setMode("ai");
            sendAi(text, "ai");
          }}
          onNavigate={(href) => {
            setIsOpen(false);
            window.location.href = href;
          }}
          onSwitchToSupport={() => setMode("support")}
          onStartFresh={() => {
            if (effectiveMode === "ai") {
              resetAiMessages();
            } else {
              support.startNewConversation();
            }
          }}
        />

        {/* Header — one row while typing (≈56px, as in WhatsApp) */}
        <div className="bg-white border-b border-gray-100 pt-4 px-4 pb-0 flex flex-col shrink-0 group-data-[typing]/panel:pt-2">
          <div className="flex items-center justify-between mb-4 group-data-[typing]/panel:mb-2">
            <div className="flex items-center gap-2">
              {/* Until the kill-switch answer is in, the header must not brand
                  itself as the AI assistant — `mode` still defaults to "ai", so
                  without this the title, sparkle icon and status all rendered
                  "Majestic AI · Ready to assist" for the few frames before the
                  config landed, even with the switch off. */}
              <div className="w-8 h-8 rounded-full bg-primaryGreen text-white flex items-center justify-center">
                {!configResolved ? (
                  <MessageCircle className="w-4 h-4" />
                ) : effectiveMode === "ai" ? (
                  <Sparkles className="w-4 h-4" />
                ) : (
                  <Headset className="w-4 h-4" />
                )}
              </div>
              <div>
                <h3 id="mc-chat-title" className="font-semibold text-graphite text-[15px] leading-tight">
                  {!configResolved
                    ? "Majestic Escape"
                    : effectiveMode === "ai"
                    ? "Majestic AI"
                    : support.assignedAdminName && support.status === "open"
                    ? `${support.assignedAdminName} is helping you`
                    : "Customer Support"}
                </h3>
                <p className="text-stone text-[11px] flex items-center gap-1 mt-0.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      !configResolved
                        ? "bg-gray-400"
                        : needsLoginForSupport
                        ? "bg-gray-400"
                        : showConnecting
                        ? "bg-amber-500"
                        : effectiveMode === "support" && support.status === "resolved"
                        ? "bg-gray-400"
                        : "bg-green-500"
                    }`}
                  />
                  {/* Without the sign-in branch this reads "Connecting…" forever
                      for a signed-out visitor, because we deliberately never
                      open a socket for them. */}
                  {!configResolved
                    ? "Loading…"
                    : needsLoginForSupport
                    ? "Sign in to start"
                    : effectiveMode === "ai"
                    ? "Ready to assist"
                    : showConnecting
                    ? "Connecting…"
                    : support.status === "resolved"
                    ? "Conversation closed"
                    : support.assignedAdminName
                    ? "Agent online"
                    : "Agents are online"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                ref={menuButtonRef}
                onClick={() => setMenuOpen((o) => !o)}
                className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-500 hover:text-gray-800"
                aria-label={menuOpen ? "Close menu" : "Open menu"}
                aria-expanded={menuOpen}
              >
                <MenuIcon className="w-5 h-5" />
              </button>
            <button
              onClick={(e) => {
                closedByKeyboardRef.current = e.detail === 0; // Enter/Space, not a tap or click
                setIsOpen(false);
              }}
              className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-500 hover:text-gray-800"
              aria-label="Close chat"
            >
              <X className="w-5 h-5" />
            </button>
            </div>
          </div>

          {/* Mode Toggle — Support is hidden for anonymous users so we always
              have an authenticated identity tied to support requests, and the
              AI tab disappears entirely when ops disable the assistant. When
              only one of the two is available there's nothing to toggle, so the
              control is dropped rather than rendered with a single option.
              Folded away while typing — the keyboard leaves too little room —
              and faded back in when it closes (the animation replays when
              the row is displayed again). */}
          {showModeTabs && (
            <div className="flex bg-gray-100 p-1 rounded-lg mb-3 motion-safe:animate-fade-in-up group-data-[typing]/panel:hidden">
              {aiAvailable && (
                <button
                  onClick={() => setMode("ai")}
                  className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all ${
                    effectiveMode === "ai"
                      ? "bg-white text-primaryGreen shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" /> AI Assistant
                </button>
              )}
              {supportAvailable && (
                <button
                  onClick={() => setMode("support")}
                  className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all ${
                    effectiveMode === "support"
                      ? "bg-white text-primaryGreen shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  <Headset className="w-3.5 h-3.5" /> Support
                </button>
              )}
            </div>
          )}
          {!showModeTabs && <div className="mb-3 group-data-[typing]/panel:hidden" />}
        </div>

        {/* Messages — `overscroll-contain` stops the scroll chain from
            propagating to the body when the user reaches the top/bottom of
            the list, so the host page never scrolls in the background.
            Tagged with a ref so the global touchmove blocker on mobile can
            allow finger-drag scrolling INSIDE this region while preventing it
            anywhere else (header, footer, backdrop, host page beneath). */}
        <div ref={messagesScrollRef} onScroll={onMessagesScroll} className="flex-1 overflow-y-auto overscroll-contain p-4 bg-gray-50/50 flex flex-col gap-4 [scrollbar-width:thin] [scrollbar-color:#CBD5E1_transparent]">
          {/* Nothing about either mode until the kill-switch answer lands.
              `mode` defaults to "ai", so without this gate the AI greeting and
              the "Try asking about:" prompts painted before we knew whether the
              assistant was even enabled — the exact flash reported on prod. */}
          {!configResolved && (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-primaryGreen/60" />
            </div>
          )}

          {/* The starter prompts wait until the saved conversation has been
              looked up: a returning visitor's history would replace them a
              moment later, and the swap flickered on open. */}
          {configResolved && !hasUserMessage && effectiveMode === "ai" && aiAvailable && aiHistoryReady && (
            <div className="flex flex-col gap-2 mb-2 animate-fade-in-up">
              <p className="text-xs font-medium text-gray-500 ml-1">Try asking about:</p>
              <div className="flex flex-col gap-2">
                {aiQuickPrompts.map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(undefined, prompt.text)}
                    className="flex items-center gap-2 text-left text-sm bg-white border border-gray-200 hover:border-primaryGreen hover:text-primaryGreen text-gray-700 px-3 py-2.5 rounded-xl transition-colors shadow-sm"
                  >
                    <span className="text-primaryGreen/70">{prompt.icon}</span>
                    {prompt.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* AI off AND anonymous — the only state with no usable tab. Give a
              clear way forward instead of an empty panel. Deliberately says
              nothing about the assistant being disabled. */}
          {needsLoginForSupport && (
            <div className="flex flex-col items-center text-center gap-3 py-8 px-4 animate-fade-in-up">
              <div className="w-12 h-12 rounded-full bg-primaryGreen/10 text-primaryGreen flex items-center justify-center">
                <Headset className="w-6 h-6" />
              </div>
              <div>
                <p className="text-[15px] font-semibold text-graphite">
                  Chat with our team
                </p>
                <p className="text-[13px] text-stone mt-1 max-w-[15rem]">
                  Sign in and our support team will help you with bookings,
                  stays and anything else.
                </p>
              </div>
              <a
                href="/login"
                className="inline-flex items-center justify-center bg-primaryGreen hover:bg-brightGreen text-white text-[13px] font-medium rounded-full px-5 py-2.5 transition-colors"
              >
                Sign in
              </a>
            </div>
          )}

          {/* Likewise nothing of the support conversation until it has come
              in — the starter prompts used to show, and even take taps, then
              vanish under the history. The spinner only fades in if the
              wait is noticeable (mc-delayed-fade), so a quick join shows none. */}
          {configResolved && effectiveMode === "support" && supportAvailable && !support.joined && (
            <div className="flex-1 flex items-center justify-center">
              <span className="mc-delayed-fade" aria-hidden="true">
                <Loader2 className="w-5 h-5 animate-spin text-primaryGreen/60" />
              </span>
            </div>
          )}

          {support.joined && !hasUserMessage && effectiveMode === "support" && !needsLoginForSupport && (
            <div className="flex flex-col gap-2 mb-2 animate-fade-in-up">
              <p className="text-xs font-medium text-gray-500 ml-1">How can we help you?</p>
              <div className="flex flex-col gap-2">
                {supportQuickPrompts.map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(undefined, prompt.text)}
                    className="flex items-center gap-2 text-left text-sm bg-white border border-gray-200 hover:border-primaryGreen hover:text-primaryGreen text-gray-700 px-3 py-2.5 rounded-xl transition-colors shadow-sm"
                  >
                    <span className="text-primaryGreen/70">{prompt.icon}</span>
                    {prompt.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages
            // Hide the optimistic empty model placeholder — until the first
            // chunk arrives the typing-dots indicator below stands in for it.
            // Without this filter the user sees an empty bubble with only a
            // timestamp while waiting for the model to start streaming.
            .filter((msg) => !(msg.role === "model" && !msg.text?.trim()))
            .map((msg) =>
              effectiveMode === "support" ? (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  onRetry={support.retryMessage}
                  onRemove={(id) => {
                    support.removeMessage(id);
                    // The button goes with the bubble; keep focus in the chat.
                    inputRef.current?.focus({ preventScroll: true });
                  }}
                />
              ) : (
                <MessageBubble key={msg.id} message={msg} />
              )
            )}

          {isLoading && (
            <div className="flex justify-start animate-fade-in-up">
              <div className="bg-white border border-gray-100 text-graphite rounded-2xl rounded-tl-sm py-3 px-4 shadow-sm flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-primaryGreen/50 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 bg-primaryGreen/50 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 bg-primaryGreen/50 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="text-center p-3 bg-red-50 text-red-600 rounded-lg text-sm border border-red-100">
              {error}
            </div>
          )}
        </div>

        {/* Input area — three states for support: open, awaiting-rating, closed.
            Suppressed entirely when the visitor has to sign in first (there is
            no conversation to type into, and a dead input is worse than none)
            and while the kill-switch answer is still pending — otherwise the
            "Ask AI to find stays..." placeholder appears before we know whether
            the assistant is enabled. */}
        <div className="p-4 bg-white border-t border-gray-100 shrink-0 group-data-[typing]/panel:py-2">
          {!configResolved || needsLoginForSupport ? null : effectiveMode === "support" &&
            support.awaitingRating ? (
            <RatingPrompt
              onSubmit={(stars, comment) => support.submitRating(stars, comment)}
              onSkip={() => {
                support.dismissRating();
                support.startNewConversation();
              }}
              alreadyRated={!!support.rating}
              ratingValue={support.rating?.stars ?? 0}
            />
          ) : effectiveMode === "support" && support.status === "resolved" ? (
            <div className="flex flex-col items-center gap-2">
              <p className="text-[12px] text-stone text-center">
                {support.rating
                  ? `Thanks for the ${"★".repeat(support.rating.stars)} feedback!`
                  : "This conversation has been closed."}
              </p>
              <button
                onClick={() => support.startNewConversation()}
                className="text-[12px] text-primaryGreen font-medium underline"
              >
                Start a new conversation
              </button>
            </div>
          ) : (
            <>
              {effectiveMode === "support" && support.peerTyping && (
                <div className="px-1 mb-1 text-[11px] text-stone italic flex items-center gap-1.5 animate-fade-in-up">
                  <span className="flex gap-0.5">
                    <span className="w-1 h-1 bg-stone rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1 h-1 bg-stone rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1 h-1 bg-stone rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  {(support.assignedAdminName ?? "Support agent")} is typing…
                </div>
              )}
              {/* items-end, not items-center: as the field grows past one
                  line the send button stays pinned to its bottom edge
                  (WhatsApp-style), not re-centred in the whole grown height. */}
              <form onSubmit={(e) => handleSend(e)} className="relative flex items-end">
                <ComposerField
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    if (effectiveMode === "support") support.notifyTyping();
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={effectiveMode === "ai" ? "Ask AI to find stays..." : "Type your message..."}
                  className="w-full bg-gray-100 border border-transparent text-graphite text-[14px] leading-5 rounded-[1.25rem] pl-4 pr-12 py-3 focus:outline-none focus:bg-white focus:border-primaryGreen focus:ring-1 focus:ring-primaryGreen transition-all placeholder:text-gray-400 disabled:opacity-60"
                  maxLength={2000}
                />
              <button
                type="submit"
                // Tapping it must not take focus from the message box: that
                // closed the phone keyboard after every send. For the same
                // reason it is never `disabled` — a tap on a disabled button
                // moves focus without reaching onMouseDown. It only looks and
                // announces unavailable; handleSend checks canSend.
                aria-disabled={!inputValue.trim() || !canSend}
                onMouseDown={(e) => e.preventDefault()}
                className="absolute right-1.5 bottom-1.5 p-2 bg-primaryGreen text-white rounded-full hover:bg-brightGreen aria-disabled:opacity-50 aria-disabled:hover:bg-primaryGreen transition duration-150 motion-safe:active:scale-90 aria-disabled:active:scale-100 flex items-center justify-center"
                aria-label="Send message"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4 ml-0.5" />
                )}
              </button>
            </form>
            </>
          )}
          {/* Not while typing: the keyboard leaves no room for it. It is
              there whenever the keyboard is down, and fades back in. */}
          <div className="text-center mt-2 motion-safe:animate-fade-in-up group-data-[typing]/panel:hidden">
            <span className="text-[10px] text-gray-400 font-medium">
              {/* Neutral until resolved — "AI can make mistakes" is an AI
                  surface too, and it sits below the fold of the same flash. */}
              {!configResolved
                ? ""
                : effectiveMode === "ai"
                ? "AI can make mistakes. Verify important info."
                : "Powered by Majestic Support"}
            </span>
          </div>
        </div>
      </div>

      {/* Launcher Button — robot mascot with floating idle bob, soft halo
          pulse for ambient attention, and a one-shot wiggle on hover. The
          launcher is wrapped in a sized container so the absolutely-
          positioned halo doesn't shift the bottom-right offset of the panel.
          When the chat is open the launcher fades + scales out (instead of
          rotating, which looked off with the mascot's face). It fades where
          it stands, and is `invisible` once faded, so it is no hidden Tab
          stop while the panel is open. The button transitions transform and
          shadow only — `transition-all` also eased its inherited visibility,
          leaving it unfocusable for a moment on close. */}
      <div
        className={`
          relative w-16 h-16 duration-300 ease-out
          ${
            isOpen
              ? "invisible opacity-0 scale-75 pointer-events-none transition-[opacity,transform,visibility]"
              : "visible opacity-100 scale-100 pointer-events-auto transition-[opacity,transform]"
          }
        `}
      >
        {/* Soft pulsing halo — primaryGreen ring fading outward. Pure visual
            cue; aria-hidden so screen readers don't announce it. */}
        {!isOpen && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full bg-primaryGreen/40 mc-halo pointer-events-none"
            style={{ animation: "mc-halo 10s ease-out infinite" }}
          />
        )}
        <button
          ref={launcherRef}
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="
            group relative w-16 h-16 rounded-full shadow-floating
            flex items-center justify-center
            bg-gradient-to-br from-white via-white to-lightGreen/40
            ring-2 ring-primaryGreen/20 hover:ring-primaryGreen/50
            transition-[transform,box-shadow] duration-300 ease-out
            hover:scale-110 hover:shadow-[0_12px_36px_rgba(54,98,31,0.35)]
            active:scale-95
            focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primaryGreen/40
          "
          aria-label={
            // Mode-aware: with the assistant switched off there is no AI chat
            // to open, and announcing one to a screen-reader user would promise
            // a tab that isn't rendered.
            aiAvailable ? "Open Majestic AI chat" : "Open Majestic Support chat"
          }
        >
          {/* Robot mascot — served from the widget origin so it survives
              build:embed (which only wipes public/embed). Idle float lives on
              the image so the halo and ring stay still. Hover wiggles the
              robot once for a friendly greeting. */}
          <img
            src={`${getBackendUrl()}/robot.png`}
            alt=""
            draggable={false}
            className="
              w-11 h-11 select-none pointer-events-none
              drop-shadow-[0_2px_4px_rgba(0,0,0,0.12)]
            "
            style={{ animation: "mc-float 3.6s ease-in-out infinite" }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.animation = "mc-wiggle 0.6s ease-in-out, mc-float 3.6s ease-in-out infinite 0.6s";
              el.addEventListener(
                "animationend",
                () => {
                  el.style.animation = "mc-float 3.6s ease-in-out infinite";
                },
                { once: true }
              );
            }}
          />
          {/* New-conversation indicator — small green-tinted dot with a
              gentle bounce so it reads as "hey, fresh chat" without the
              alarm-bell red of the previous version. */}
          {!isOpen && messages.length === 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-brightGreen border-2 border-white rounded-full mc-pop-in"
              style={{ animation: "mc-pop-in 0.4s ease-out 0.6s both, bounce 2s ease-in-out 1s 3" }}
            />
          )}
        </button>
      </div>
      </div>
    </>
  );
};
