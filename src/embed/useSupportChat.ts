import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Message, SupportRating, SystemMessageKind } from "./types";
import { getAuthToken, getBackendUrl, getOrCreateGuestId } from "./utils";

interface ServerMessage {
  _id: string;
  from: "user" | "admin" | "system";
  authorId: string | null;
  authorName: string | null;
  text: string;
  createdAt: string;
  kind?: SystemMessageKind;
  clientMessageId?: string;
}

function toLocal(m: ServerMessage): Message {
  // Most server-generated "system" messages (join / handover / resolve / reopen)
  // render as centred italic chips — they are status events, not chat content.
  // The exception is `kind: "auto"` (the templated auto-acknowledgement we
  // send when a user first messages support): that's a *reply* to the user
  // and should render as a regular agent bubble so it visually matches the
  // greeting and any subsequent human admin replies.
  const renderAsAgent = m.from !== "user" && m.kind !== "join" && m.kind !== "handover" && m.kind !== "resolve" && m.kind !== "reopen";
  return {
    id: m._id,
    serverId: m._id,
    role: m.from === "user" ? "user" : renderAsAgent ? "model" : "system",
    text: m.text,
    timestamp: new Date(m.createdAt),
    isSupport: true,
    authorName: m.authorName,
    systemKind: m.kind,
    clientMessageId: m.clientMessageId,
  };
}

export interface UseSupportChat {
  messages: Message[];
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  status: "pending" | "open" | "resolved" | null;
  assignedAdminName: string | null;
  rating: SupportRating | null;
  awaitingRating: boolean;
  peerTyping: boolean;
  connect: () => void;
  disconnect: () => void;
  sendMessage: (text: string) => void;
  notifyTyping: () => void;
  submitRating: (stars: number, comment?: string) => void;
  dismissRating: () => void;
  startNewConversation: () => void;
}

export function useSupportChat(): UseSupportChat {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"pending" | "open" | "resolved" | null>(null);
  const [assignedAdminName, setAssignedAdminName] = useState<string | null>(null);
  const [rating, setRating] = useState<SupportRating | null>(null);
  const [awaitingRating, setAwaitingRating] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const typingActiveRef = useRef(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (socketRef.current?.connected) return;
    setError(null);

    const token = getAuthToken();
    const guestSessionId = getOrCreateGuestId() ?? "";

    const sock = io(`${getBackendUrl()}/support`, {
      auth: { token, guestSessionId },
      transports: ["websocket", "polling"],
      autoConnect: true,
    });
    socketRef.current = sock;

    sock.on("connect", () => {
      setIsConnected(true);
      sock.emit("support:start", { guestSessionId });
    });

    sock.on("disconnect", () => setIsConnected(false));

    sock.on("connect_error", (err) => {
      console.error("[support] connect_error", err);
      setError("Couldn't reach support. Retrying…");
    });

    sock.on(
      "support:joined",
      (payload: {
        conversationId: string;
        history: ServerMessage[];
        status: "pending" | "open" | "resolved";
        assignedAdminId: string | null;
        assignedAdminName: string | null;
        rating: SupportRating | null;
        awaitingRating: boolean;
      }) => {
        conversationIdRef.current = payload.conversationId;
        setStatus(payload.status);
        setAssignedAdminName(payload.assignedAdminName);
        setRating(payload.rating);
        setAwaitingRating(!!payload.awaitingRating);
        const history = payload.history.map(toLocal);
        const greeting: Message = {
          id: "support-greeting",
          role: "model",
          text:
            "Hi! You're now connected to Majestic Support. Tell us how we can help — an agent will respond shortly.",
          timestamp: new Date(),
          isSupport: true,
        };
        setMessages(history.length > 0 ? history : [greeting]);
      }
    );

    sock.on(
      "support:message",
      (payload: { conversationId: string; message: ServerMessage }) => {
        if (payload.conversationId !== conversationIdRef.current) return;
        const incoming = toLocal(payload.message);
        setMessages((prev) => {
          if (prev.some((m) => m.serverId && m.serverId === incoming.serverId)) return prev;
          if (incoming.clientMessageId) {
            const idx = prev.findIndex((m) => m.clientMessageId === incoming.clientMessageId);
            if (idx >= 0) {
              const next = prev.slice();
              next[idx] = incoming;
              return next;
            }
          }
          return [...prev, incoming];
        });
      }
    );

    sock.on(
      "support:status",
      (payload: {
        conversationId: string;
        status: "pending" | "open" | "resolved";
        assignedAdminId?: string | null;
        assignedAdminName?: string | null;
      }) => {
        if (payload.conversationId !== conversationIdRef.current) return;
        setStatus(payload.status);
        if (payload.assignedAdminName !== undefined)
          setAssignedAdminName(payload.assignedAdminName ?? null);
        if (payload.status === "resolved") {
          setAwaitingRating(true);
        } else if (payload.status === "open") {
          setAwaitingRating(false);
        }
      }
    );

    sock.on(
      "support:rated",
      (payload: { conversationId: string; rating: SupportRating }) => {
        if (payload.conversationId !== conversationIdRef.current) return;
        setRating(payload.rating);
        setAwaitingRating(false);
      }
    );

    sock.on("support:error", (payload: { reason: string }) => {
      setError(payload.reason);
    });

    sock.on(
      "support:typing",
      (payload: {
        conversationId: string;
        from: "user" | "admin";
        isTyping: boolean;
      }) => {
        if (payload.conversationId !== conversationIdRef.current) return;
        if (payload.from === "admin") setPeerTyping(!!payload.isTyping);
      }
    );
  }, []);

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    conversationIdRef.current = null;
    setIsConnected(false);
  }, []);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (status === "resolved") {
        setError("This conversation has been closed. Start a new one to continue.");
        return;
      }
      if (!socketRef.current?.connected || !conversationIdRef.current) {
        setError("Not connected to support yet — please wait a moment.");
        return;
      }
      setIsLoading(true);
      setError(null);

      const clientMessageId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: Message = {
        id: clientMessageId,
        clientMessageId,
        role: "user",
        text: trimmed,
        timestamp: new Date(),
        isSupport: true,
      };
      setMessages((prev) => [...prev, optimistic]);

      socketRef.current.emit(
        "support:message",
        { conversationId: conversationIdRef.current, text: trimmed, clientMessageId },
        (ack: { ok: boolean; error?: string } | undefined) => {
          setIsLoading(false);
          if (ack && !ack.ok) {
            setError(ack.error || "Send failed");
            setMessages((prev) => prev.filter((m) => m.clientMessageId !== clientMessageId));
          }
        }
      );
      setTimeout(() => setIsLoading(false), 5000);
    },
    [status]
  );

  const notifyTyping = useCallback(() => {
    if (!socketRef.current?.connected || !conversationIdRef.current) return;
    if (status === "resolved") return;
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      socketRef.current.emit("support:typing", {
        conversationId: conversationIdRef.current,
        isTyping: true,
      });
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      typingActiveRef.current = false;
      socketRef.current?.emit("support:typing", {
        conversationId: conversationIdRef.current,
        isTyping: false,
      });
    }, 2000);
  }, [status]);

  const submitRating = useCallback((stars: number, comment?: string) => {
    if (!socketRef.current?.connected || !conversationIdRef.current) {
      setError("Not connected. Try again in a moment.");
      return;
    }
    socketRef.current.emit(
      "support:rate",
      { conversationId: conversationIdRef.current, stars, comment },
      (ack: { ok: boolean; error?: string } | undefined) => {
        if (ack && !ack.ok) setError(ack.error || "Couldn't submit rating.");
      }
    );
  }, []);

  const dismissRating = useCallback(() => {
    if (socketRef.current?.connected && conversationIdRef.current) {
      socketRef.current.emit("support:rating-dismissed", {
        conversationId: conversationIdRef.current,
      });
    }
    setAwaitingRating(false);
  }, []);

  // Starts a fresh conversation. If the user is currently looking at a
  // resolved-unrated conversation, we MUST wait for the rating-dismissed ack
  // before emitting `support:start` — otherwise the server's onUserConnect
  // re-finds the still-unrated conversation and replays the rating prompt
  // (the Skip button "doesn't advance" race).
  const startNewConversation = useCallback(() => {
    const sock = socketRef.current;
    if (!sock?.connected) return;
    const wasAwaitingRating = status === "resolved" && awaitingRating;
    const conversationId = conversationIdRef.current;

    setMessages([]);
    setStatus(null);
    setAssignedAdminName(null);
    setRating(null);
    setAwaitingRating(false);
    conversationIdRef.current = null;

    if (wasAwaitingRating && conversationId) {
      // Use the ack-callback variant so the server's ratingDismissedAt write
      // is committed before we trigger onUserConnect via support:start.
      sock.emit(
        "support:rating-dismissed",
        { conversationId },
        () => {
          // Even if the ack errored, still try to start a new convo —
          // the user has unambiguously asked to move on.
          sock.emit("support:start", {});
        }
      );
    } else {
      sock.emit("support:start", {});
    }
  }, [status, awaitingRating]);

  return {
    messages,
    isConnected,
    isLoading,
    error,
    status,
    assignedAdminName,
    rating,
    awaitingRating,
    peerTyping,
    connect,
    disconnect,
    sendMessage,
    notifyTyping,
    submitRating,
    dismissRating,
    startNewConversation,
  };
}
