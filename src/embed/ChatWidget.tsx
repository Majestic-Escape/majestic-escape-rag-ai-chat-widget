import React, { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentPathname, getBackendUrl } from "./utils";
import {
  X,
  Send,
  Loader2,
  Sparkles,
  Headset,
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
import { useSupportChat } from "./useSupportChat";
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

const MessageBubble: React.FC<{ message: Message }> = ({ message }) => {
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
  isLoggedIn: boolean;
  mode: ChatMode;
  onClose: () => void;
  onPrompt: (text: string) => void;
  onNavigate: (href: string) => void;
  onSwitchToSupport: () => void;
  onStartFresh: () => void;
}

const MainMenuDrawer: React.FC<MainMenuDrawerProps> = ({
  isOpen,
  isLoggedIn,
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

  // Visible sections after applying the logged-in filter — and we drop any
  // section that has no tiles left for this user.
  const visibleSections = MENU_SECTIONS.map((s) => ({
    ...s,
    tiles: s.tiles.filter((t) => !t.requiresLogin || isLoggedIn),
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

      {/* Drawer panel — slides down from the top of the chat panel. */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Chatbot menu"
        className={`
          absolute left-0 right-0 top-0 z-40 max-h-[88%] overflow-y-auto
          bg-white/98 backdrop-blur-md shadow-xl rounded-t-2xl
          transition-transform duration-200 ease-out
          ${isOpen ? "translate-y-0" : "-translate-y-full pointer-events-none"}
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

export const ChatWidget: React.FC = () => {
  const pathname = useCurrentPathname();
  const hidden = shouldHideOnPath(pathname);

  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<ChatMode>("ai");
  const [inputValue, setInputValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // Re-checked when the panel opens; covers logout-mid-session.
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const {
    aiMessages,
    isLoading: aiLoading,
    error: aiError,
    sendMessage: sendAi,
    initChat: initAi,
    resetAiMessages,
  } = useChat();
  const support = useSupportChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);

  // Show only the active tab's history; AI from local hook, Support from Socket.IO hook.
  const messages = mode === "ai" ? aiMessages : support.messages;
  const isLoading = mode === "ai" ? aiLoading : support.isLoading;
  const error = mode === "ai" ? aiError : support.error;
  const hasUserMessage = messages.some((m) => m.role === "user");

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading, mode]);

  // Close the menu when the entire chat panel closes — otherwise reopening
  // the chat would surface yesterday's open menu.
  useEffect(() => {
    if (!isOpen) setMenuOpen(false);
  }, [isOpen]);

  // AI greeting on open (Support greeting comes from server when Socket.IO joins).
  // NOTE: we deliberately DO NOT autofocus the input here — auto-focus opens
  // the mobile keyboard immediately, which jolts the panel layout and feels
  // intrusive when a user just taps the chat icon. Users tap the input when
  // they're ready to type.
  useEffect(() => {
    if (isOpen && mode === "ai") initAi("ai");
  }, [isOpen, mode, initAi]);

  // Re-detect login when the panel opens. Anonymous users see only AI Assistant.
  useEffect(() => {
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
    // If user landed on Support tab but isn't logged in, send them back to AI.
    if (!loggedIn && mode === "support") setMode("ai");
  }, [isOpen, mode]);

  // Connect/disconnect the support socket only when the Support tab is active
  // and the panel is open. Depend on the STABLE connect/disconnect callbacks —
  // not the whole `support` object, which is a fresh reference on every render.
  // Using `support` here re-ran the effect each render; paired with the old
  // connect() guard that spawned a socket whenever one wasn't fully connected,
  // it stormed the browser with WebSockets ("Insufficient resources").
  const { connect: connectSupport, disconnect: disconnectSupport } = support;
  useEffect(() => {
    if (isOpen && mode === "support") {
      connectSupport();
    } else {
      disconnectSupport();
    }
  }, [isOpen, mode, connectSupport, disconnectSupport]);

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
  // because `lg:h-[650px]` wins inside the `min-width: 1024px` media query.
  useEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 1023px)");
    const vv = window.visualViewport;
    const host = document.querySelector("majestic-chat-widget") as HTMLElement | null;
    if (!host || !vv) return;
    const update = () => {
      if (mql.matches) {
        const prev = parseFloat(host.style.getPropertyValue("--mc-vvh")) || 0;
        host.style.setProperty("--mc-vvh", `${vv.height}px`);
        // `offsetTop` shifts when iOS/Android moves the visual viewport down
        // to keep the focused input visible while the keyboard is up. Pinning
        // the panel's top to that offset (plus the 8 px margin) keeps the
        // header and panel inside the visible area instead of being scrolled
        // off behind the URL/status bar at the top of the layout viewport.
        host.style.setProperty("--mc-vvtop", `${vv.offsetTop}px`);
        // When the visible area shrinks (i.e. the keyboard just opened), scroll
        // the latest message into view so it stays just above the input field.
        // Wait one frame so the panel has reflowed before we measure scrollHeight.
        if (vv.height < prev) {
          requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView({ block: "end" });
          });
        }
      } else {
        host.style.removeProperty("--mc-vvh");
        host.style.removeProperty("--mc-vvtop");
      }
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
      host.style.removeProperty("--mc-vvh");
    };
  }, [isOpen]);

  const handleSend = (e?: React.FormEvent, overrideText?: string) => {
    e?.preventDefault();
    const textToSend = overrideText || inputValue;
    if (!textToSend.trim() || isLoading) return;
    if (mode === "ai") {
      sendAi(textToSend, "ai");
    } else {
      support.sendMessage(textToSend);
    }
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
          its edge. */}
      {isOpen && (
        <div
          onClick={() => setIsOpen(false)}
          className="fixed inset-0 z-40 touch-none bg-black/50 backdrop-blur-sm lg:bg-transparent lg:backdrop-blur-none animate-fade-in-up"
          aria-hidden="true"
        />
      )}

      <div className={`fixed ${LAUNCHER_OFFSET} right-4 md:right-6 z-50 flex flex-col items-end font-poppins`}>
      {/* Chat Window — kept at its open-target position in both states so the
          transition only animates transform + opacity (which CSS can interpolate
          smoothly). Toggling between `absolute bottom-0 right-0` and `fixed
          inset-2` would snap layout instantly, which produced the "moves down,
          then opens" jank users reported. */}
      <div
        aria-hidden={!isOpen}
        className={`
          fixed left-2 right-2 top-[calc(var(--mc-vvtop,0px)+8px)]
          max-lg:h-[calc(var(--mc-vvh,100dvh)-16px)]
          lg:inset-auto lg:bottom-24 lg:right-6 lg:top-auto
          lg:w-[400px] lg:h-[760px] lg:max-h-[86vh] lg:max-w-[calc(100vw-2rem)]
          bg-white shadow-floating rounded-2xl border border-gray-200
          flex flex-col overflow-hidden
          origin-bottom-right transition-[opacity,transform] duration-300 ease-out
          ${
            isOpen
              ? "opacity-100 scale-100 translate-y-0"
              : "opacity-0 scale-95 translate-y-4 pointer-events-none"
          }
        `}
      >
        {/* Main menu drawer — overlays the messages when open. Sits above the
            header z-stack so it visually covers everything. */}
        <MainMenuDrawer
          isOpen={menuOpen}
          isLoggedIn={isLoggedIn}
          mode={mode}
          onClose={() => setMenuOpen(false)}
          onPrompt={(text) => {
            if (mode !== "ai") setMode("ai");
            sendAi(text, "ai");
          }}
          onNavigate={(href) => {
            setIsOpen(false);
            window.location.href = href;
          }}
          onSwitchToSupport={() => setMode("support")}
          onStartFresh={() => {
            if (mode === "ai") {
              resetAiMessages();
            } else {
              support.startNewConversation();
            }
          }}
        />

        {/* Header */}
        <div className="bg-white border-b border-gray-100 pt-4 px-4 pb-0 flex flex-col shrink-0">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primaryGreen text-white flex items-center justify-center">
                {mode === "ai" ? (
                  <Sparkles className="w-4 h-4" />
                ) : (
                  <Headset className="w-4 h-4" />
                )}
              </div>
              <div>
                <h3 className="font-semibold text-graphite text-[15px] leading-tight">
                  {mode === "ai"
                    ? "Majestic AI"
                    : support.assignedAdminName && support.status === "open"
                    ? `${support.assignedAdminName} is helping you`
                    : "Customer Support"}
                </h3>
                <p className="text-stone text-[11px] flex items-center gap-1 mt-0.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      mode === "support" && !support.isConnected
                        ? "bg-amber-500"
                        : mode === "support" && support.status === "resolved"
                        ? "bg-gray-400"
                        : "bg-green-500"
                    }`}
                  />
                  {mode === "ai"
                    ? "Ready to assist"
                    : !support.isConnected
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
                onClick={() => setMenuOpen((o) => !o)}
                className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-500 hover:text-gray-800"
                aria-label={menuOpen ? "Close menu" : "Open menu"}
                aria-expanded={menuOpen}
              >
                <MenuIcon className="w-5 h-5" />
              </button>
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-500 hover:text-gray-800"
              aria-label="Close chat"
            >
              <X className="w-5 h-5" />
            </button>
            </div>
          </div>

          {/* Mode Toggle — Support tab is hidden for anonymous users so we
              always have an authenticated identity tied to support requests. */}
          <div className="flex bg-gray-100 p-1 rounded-lg mb-3">
            <button
              onClick={() => setMode("ai")}
              className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all ${
                mode === "ai"
                  ? "bg-white text-primaryGreen shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" /> AI Assistant
            </button>
            {isLoggedIn && (
              <button
                onClick={() => setMode("support")}
                className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all ${
                  mode === "support"
                    ? "bg-white text-primaryGreen shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                <Headset className="w-3.5 h-3.5" /> Support
              </button>
            )}
          </div>
        </div>

        {/* Messages — `overscroll-contain` stops the scroll chain from
            propagating to the body when the user reaches the top/bottom of
            the list, so the host page never scrolls in the background.
            Tagged with a ref so the global touchmove blocker on mobile can
            allow finger-drag scrolling INSIDE this region while preventing it
            anywhere else (header, footer, backdrop, host page beneath). */}
        <div ref={messagesScrollRef} className="flex-1 overflow-y-auto overscroll-contain p-4 bg-gray-50/50 flex flex-col gap-4 [scrollbar-width:thin] [scrollbar-color:#CBD5E1_transparent]">
          {!hasUserMessage && mode === "ai" && (
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

          {!hasUserMessage && mode === "support" && (
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
            .map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

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
          <div ref={messagesEndRef} />
        </div>

        {/* Input area — three states for support: open, awaiting-rating, closed */}
        <div className="p-4 bg-white border-t border-gray-100 shrink-0">
          {mode === "support" && support.awaitingRating ? (
            <RatingPrompt
              onSubmit={(stars, comment) => support.submitRating(stars, comment)}
              onSkip={() => {
                support.dismissRating();
                support.startNewConversation();
              }}
              alreadyRated={!!support.rating}
              ratingValue={support.rating?.stars ?? 0}
            />
          ) : mode === "support" && support.status === "resolved" ? (
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
              {mode === "support" && support.peerTyping && (
                <div className="px-1 mb-1 text-[11px] text-stone italic flex items-center gap-1.5 animate-fade-in-up">
                  <span className="flex gap-0.5">
                    <span className="w-1 h-1 bg-stone rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1 h-1 bg-stone rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1 h-1 bg-stone rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  {(support.assignedAdminName ?? "Support agent")} is typing…
                </div>
              )}
              <form onSubmit={(e) => handleSend(e)} className="relative flex items-center">
                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    if (mode === "support") support.notifyTyping();
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={mode === "ai" ? "Ask AI to find stays..." : "Type your message..."}
                  className="w-full bg-gray-100 border border-transparent text-graphite text-[14px] rounded-full pl-4 pr-12 py-3 focus:outline-none focus:bg-white focus:border-primaryGreen focus:ring-1 focus:ring-primaryGreen transition-all placeholder:text-gray-400 disabled:opacity-60"
                  disabled={isLoading || (mode === "support" && !support.isConnected)}
                  maxLength={2000}
                />
              <button
                type="submit"
                disabled={!inputValue.trim() || isLoading || (mode === "support" && !support.isConnected)}
                className="absolute right-1.5 p-2 bg-primaryGreen text-white rounded-full hover:bg-brightGreen disabled:opacity-50 transition-colors flex items-center justify-center"
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
          <div className="text-center mt-2">
            <span className="text-[10px] text-gray-400 font-medium">
              {mode === "ai"
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
          rotating, which looked off with the mascot's face). */}
      <div
        className={`
          relative w-16 h-16 transition-[opacity,transform] duration-300 ease-out
          ${isOpen ? "opacity-0 scale-75 pointer-events-none absolute" : "opacity-100 scale-100"}
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
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="
            group relative w-16 h-16 rounded-full shadow-floating
            flex items-center justify-center
            bg-gradient-to-br from-white via-white to-lightGreen/40
            ring-2 ring-primaryGreen/20 hover:ring-primaryGreen/50
            transition-all duration-300 ease-out
            hover:scale-110 hover:shadow-[0_12px_36px_rgba(54,98,31,0.35)]
            active:scale-95
            focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primaryGreen/40
          "
          aria-label="Open Majestic AI chat"
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
