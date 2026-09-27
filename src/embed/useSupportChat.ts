import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Message, SupportRating } from "./types";
import { getAuthToken, getBackendUrl, getOrCreateGuestId } from "./utils";
import {
  ACK_TIMEOUT_MS,
  OUTBOX_MAX,
  OutboxEntry,
  PRE_ATTACH_MAX,
  ServerMessage,
  applyIncoming,
  decideOnRejoin,
  mergeInto,
  newClientMessageId,
  retryKind,
  toLocal,
} from "./supportThread";

// Protocol 2: opening Support creates nothing. The server answers the join
// with a draft (`conversationId: null`) and the first message creates the
// conversation, announced by `support:started` before that message's echo.
const PROTOCOL = 2;

type Status = "pending" | "open" | "resolved";

interface JoinedPayload {
  conversationId: string | null;
  history: ServerMessage[];
  status: Status | null;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  rating: SupportRating | null;
  awaitingRating: boolean;
}

interface StartedPayload {
  conversationId: string;
  status: Status;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  history: ServerMessage[];
}

interface MessageAck {
  ok: boolean;
  error?: string;
  conversationId?: string;
  messageId?: string;
  duplicate?: boolean;
}

export type RetryResult = "sent" | "confirm" | "unavailable";

export interface UseSupportChatOptions {
  /**
   * The server refused a message. Return true if its text went back into the
   * (empty) message box — the bubble is then removed; otherwise the bubble
   * stays as "Not sent" so nothing typed is lost.
   */
  restoreToComposer?: (text: string) => boolean;
}

export interface UseSupportChat {
  messages: Message[];
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  status: Status | null;
  assignedAdminName: string | null;
  rating: SupportRating | null;
  awaitingRating: boolean;
  peerTyping: boolean;
  /** The conversation has come in from the server at least once (kept through reconnects). */
  joined: boolean;
  /** Messages from this device the server hasn't confirmed (sending, not sent, unconfirmed). */
  pendingCount: number;
  connect: () => void;
  disconnect: () => void;
  /** Whether the message went out; if not, the caller keeps it (the reason is in `error`). */
  sendMessage: (text: string) => boolean;
  /**
   * Sends a "Not sent" / "Delivery not confirmed" message again. "confirm":
   * it may already have been delivered — ask, then call again with
   * `confirmed: true` (it then goes as a new message).
   */
  retryMessage: (localId: string, confirmed?: boolean) => RetryResult;
  removeMessage: (localId: string) => void;
  notifyTyping: () => void;
  submitRating: (stars: number, comment?: string) => void;
  dismissRating: () => void;
  startNewConversation: () => void;
  /** Hang up and drop the conversation, for when the signed-in person changes. */
  forget: () => void;
}

const NOT_CONNECTED = "Not connected to support yet — please wait a moment.";
const CLOSED = "This conversation has been closed. Start a new one to continue.";

export function useSupportChat(options: UseSupportChatOptions = {}): UseSupportChat {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [assignedAdminName, setAssignedAdminName] = useState<string | null>(null);
  const [rating, setRating] = useState<SupportRating | null>(null);
  const [awaitingRating, setAwaitingRating] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);
  // Not reset on disconnect: the panel keeps showing the conversation while
  // it reconnects, instead of an empty state that the history then replaces.
  const [joined, setJoined] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  // null while in a draft (or before the first join).
  const conversationIdRef = useRef<string | null>(null);
  const statusRef = useRef<Status | null>(null);
  // This connection has had its join answered. Until then, conversation
  // events are held (≤ PRE_ATTACH_MAX) and applied after the join, which
  // carries an older snapshot than they do.
  const attachedRef = useRef(false);
  const preAttachRef = useRef<(() => void)[]>([]);
  const preAttachOverflowRef = useRef(false);
  const outboxRef = useRef(new Map<string, OutboxEntry>());
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingActiveRef = useRef(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visHandlerRef = useRef<(() => void) | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const setStatusBoth = useCallback((next: Status | null) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const setDelivery = useCallback((localId: string, deliveryState: Message["deliveryState"], failureReason?: string) => {
    setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, deliveryState, failureReason } : m)));
  }, []);

  // The server has it (by ack): the bubble becomes that message — or goes,
  // if that message is already on screen from a history or echo.
  const confirmDelivered = useCallback((localId: string, serverId?: string) => {
    setMessages((prev) => {
      if (serverId && prev.some((m) => m.serverId === serverId && m.id !== localId)) {
        return prev.filter((m) => m.id !== localId);
      }
      return prev.map((m) =>
        m.id === localId ? { ...m, serverId: serverId ?? m.serverId, deliveryState: undefined, failureReason: undefined } : m
      );
    });
  }, []);

  const clearLoading = useCallback(() => {
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = null;
    setIsLoading(false);
  }, []);

  // Puts one outbox entry on the wire and settles it from the answer. Only
  // the latest transmission of an entry may settle it.
  const transmit = useCallback(
    (entry: OutboxEntry, sock: Socket, userInitiated: boolean) => {
      entry.attempt += 1;
      entry.inFlight = true;
      const attempt = entry.attempt;
      setDelivery(entry.localId, "sending");
      sock.timeout(ACK_TIMEOUT_MS).emit(
        "support:message",
        { conversationId: entry.target, text: entry.text, clientMessageId: entry.clientMessageId },
        (err: Error | null, ack: MessageAck | undefined) => {
          if (userInitiated) clearLoading();
          const current = outboxRef.current.get(entry.localId);
          if (current !== entry || entry.attempt !== attempt) return;
          entry.inFlight = false;
          if (err || !ack || typeof ack.ok !== "boolean") {
            // No answer (timeout or the connection dropped): it may or may
            // not be stored. The rejoin decides, or the person does.
            setDelivery(entry.localId, "unconfirmed");
            return;
          }
          if (ack.ok) {
            outboxRef.current.delete(entry.localId);
            confirmDelivered(entry.localId, ack.messageId);
            return;
          }
          const reason = ack.error || "Couldn't send your message.";
          const restore = optionsRef.current.restoreToComposer;
          if (restore?.(entry.text)) {
            outboxRef.current.delete(entry.localId);
            setMessages((prev) => prev.filter((m) => m.id !== entry.localId));
            setError(reason);
            return;
          }
          entry.refused = true;
          setDelivery(entry.localId, "failed", reason);
        }
      );
    },
    [setDelivery, confirmDelivered, clearLoading]
  );

  // After a join: settle what the last connection left unanswered.
  const reconcileOutbox = useCallback(
    (sock: Socket, joinedId: string | null, history: Message[]) => {
      const held = new Set(history.map((m) => m.clientMessageId).filter((id): id is string => !!id));
      const now = Date.now();
      for (const entry of [...outboxRef.current.values()]) {
        // Refused ones wait for the person. One still waiting for its answer
        // on this connection is left to that answer (an older server answers
        // a connect with two joins).
        if (entry.refused || entry.inFlight) continue;
        const decision = decideOnRejoin(entry, joinedId, held, now);
        if (decision === "delivered") {
          outboxRef.current.delete(entry.localId);
        } else if (decision === "resend") {
          entry.autoResends += 1;
          transmit(entry, sock, false);
        } else {
          entry.autoResends = Infinity; // manual from here on
          setDelivery(entry.localId, "unconfirmed");
        }
      }
    },
    [transmit, setDelivery]
  );

  const resetConversationState = useCallback(() => {
    outboxRef.current.clear();
    preAttachRef.current = [];
    preAttachOverflowRef.current = false;
    conversationIdRef.current = null;
    setMessages([]);
    setStatusBoth(null);
    setAssignedAdminName(null);
    setRating(null);
    setAwaitingRating(false);
    setPeerTyping(false);
    setJoined(false);
  }, [setStatusBoth]);

  const connect = useCallback(() => {
    // A socket already exists (connected, connecting, OR reconnecting). Never
    // create a second one — Socket.IO's own reconnection handles every drop.
    // The old guard only checked `.connected`, so a still-connecting socket
    // let callers spawn duplicates; combined with the connect/effect render
    // loop that storms the browser with WebSockets until it rejects them all
    // with "Insufficient resources" and the input stays disabled forever.
    if (socketRef.current) return;
    setError(null);

    const token = getAuthToken();
    const guestSessionId = getOrCreateGuestId() ?? "";

    const sock = io(`${getBackendUrl()}/support`, {
      auth: { token, guestSessionId, proto: PROTOCOL },
      transports: ["websocket", "polling"],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = sock;
    const live = () => socketRef.current === sock;

    // Conversation events wait for this connection's join (see attachedRef).
    const held =
      <T,>(apply: (payload: T) => void) =>
      (payload: T) => {
        if (!live()) return;
        if (attachedRef.current) {
          apply(payload);
          return;
        }
        if (preAttachRef.current.length < PRE_ATTACH_MAX) preAttachRef.current.push(() => apply(payload));
        else preAttachOverflowRef.current = true;
      };

    const attached = () => {
      attachedRef.current = true;
      const queued = preAttachRef.current;
      preAttachRef.current = [];
      for (const run of queued) run();
      if (preAttachOverflowRef.current) {
        // Too much arrived before the join to hold: ask for a fresh snapshot.
        preAttachOverflowRef.current = false;
        attachedRef.current = false;
        sock.emit("support:start", {});
      }
    };

    sock.on("connect", () => {
      if (!live()) return;
      attachedRef.current = false;
      preAttachRef.current = [];
      preAttachOverflowRef.current = false;
      setIsConnected(true);
      setError(null);
      sock.emit("support:start", { guestSessionId });
    });

    sock.on("disconnect", (reason) => {
      if (!live()) return;
      attachedRef.current = false;
      setIsConnected(false);
      // "io server disconnect" is the one drop Socket.IO will NOT auto-
      // reconnect from — reconnect manually so the input never stays stuck.
      if (reason === "io server disconnect") sock.connect();
    });

    sock.on("connect_error", (err) => {
      if (!live()) return;
      console.error("[support] connect_error", err);
      setError("Couldn't reach support. Retrying…");
    });

    sock.on("support:joined", (payload: JoinedPayload) => {
      if (!live()) return;
      const id = payload.conversationId ?? null;
      conversationIdRef.current = id;
      setStatusBoth(payload.status ?? null);
      setAssignedAdminName(payload.assignedAdminName ?? null);
      setRating(payload.rating ?? null);
      setAwaitingRating(!!payload.awaitingRating);
      setPeerTyping(false);
      const history = (payload.history ?? []).map(toLocal);
      setMessages((prev) => mergeInto(prev, history));
      setJoined(true);
      // e.g. "Not connected to support yet" from a send just before the join
      setError(null);
      reconcileOutbox(sock, id, history);
      attached();
    });

    // The customer's conversation now exists — started by this tab's first
    // message (this arrives before its echo) or by another of their tabs.
    // Taken only when this tab has nothing else open: a draft, the same
    // conversation, or a resolved one it was showing.
    sock.on(
      "support:started",
      held((payload: StartedPayload) => {
        const current = conversationIdRef.current;
        if (current === payload.conversationId) return; // already showing it, with newer state
        if (current !== null && statusRef.current !== "resolved") return;
        conversationIdRef.current = payload.conversationId;
        setStatusBoth(payload.status);
        setAssignedAdminName(payload.assignedAdminName ?? null);
        setRating(null);
        setAwaitingRating(false);
        setPeerTyping(false);
        setMessages((prev) => mergeInto(prev, (payload.history ?? []).map(toLocal)));
        // Messages sent into the draft now belong to this conversation.
        for (const entry of outboxRef.current.values()) {
          if (entry.target === null) entry.target = payload.conversationId;
        }
      })
    );

    sock.on(
      "support:message",
      held((payload: { conversationId: string; message: ServerMessage }) => {
        if (payload.conversationId !== conversationIdRef.current) return;
        const incoming = toLocal(payload.message);
        // Its echo settles an unanswered send, whatever the ack does later.
        if (incoming.clientMessageId) {
          for (const [localId, entry] of outboxRef.current) {
            if (entry.clientMessageId === incoming.clientMessageId) outboxRef.current.delete(localId);
          }
        }
        setMessages((prev) => applyIncoming(prev, incoming));
        // What the agent was typing has arrived (as in WhatsApp).
        if (incoming.role !== "user") setPeerTyping(false);
      })
    );

    sock.on(
      "support:status",
      held(
        (payload: {
          conversationId: string;
          status: Status;
          assignedAdminId?: string | null;
          assignedAdminName?: string | null;
        }) => {
          if (payload.conversationId !== conversationIdRef.current) return;
          setStatusBoth(payload.status);
          setPeerTyping(false);
          if (payload.assignedAdminName !== undefined) setAssignedAdminName(payload.assignedAdminName ?? null);
          if (payload.status === "resolved") {
            setAwaitingRating(true);
          } else if (payload.status === "open") {
            setAwaitingRating(false);
          }
        }
      )
    );

    sock.on(
      "support:rated",
      held((payload: { conversationId: string; rating: SupportRating }) => {
        if (payload.conversationId !== conversationIdRef.current) return;
        setRating(payload.rating);
        setAwaitingRating(false);
      })
    );

    sock.on("support:error", (payload: { reason: string }) => {
      if (!live()) return;
      setError(payload?.reason ?? "Something went wrong.");
    });

    sock.on("support:typing", (payload: { conversationId: string; from: "user" | "admin"; isTyping: boolean }) => {
      if (!live() || !attachedRef.current) return;
      if (payload.conversationId !== conversationIdRef.current) return;
      if (payload.from === "admin") setPeerTyping(!!payload.isTyping);
    });

    // A backgrounded tab gets its socket throttled and eventually dropped by
    // the server's ping timeout. The moment the user returns, force an
    // immediate reconnect rather than waiting out the backoff — otherwise the
    // input sits disabled for several seconds (or longer) after every idle gap.
    const onVisible = () => {
      if (document.visibilityState === "visible" && socketRef.current && !socketRef.current.connected) {
        socketRef.current.connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    visHandlerRef.current = onVisible;
  }, [reconcileOutbox, setStatusBoth]);

  const disconnect = useCallback(() => {
    if (visHandlerRef.current) {
      document.removeEventListener("visibilitychange", visHandlerRef.current);
      visHandlerRef.current = null;
    }
    const sock = socketRef.current;
    // Cleared first, so the handlers of the closing socket are already stale.
    socketRef.current = null;
    attachedRef.current = false;
    preAttachRef.current = [];
    sock?.disconnect();
    conversationIdRef.current = null;
    setIsConnected(false);
  }, []);

  useEffect(() => {
    return () => {
      disconnect();
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, [disconnect]);

  const sendMessage = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (statusRef.current === "resolved") {
        setError(CLOSED);
        return false;
      }
      const sock = socketRef.current;
      if (!sock?.connected || !attachedRef.current) {
        setError(NOT_CONNECTED);
        return false;
      }
      if (outboxRef.current.size >= OUTBOX_MAX) {
        setError("Too many messages are waiting to be confirmed — retry or remove them first.");
        return false;
      }
      setIsLoading(true);
      setError(null);

      const clientMessageId = newClientMessageId();
      const optimistic: Message = {
        id: clientMessageId,
        clientMessageId,
        role: "user",
        text: trimmed,
        timestamp: new Date(),
        isSupport: true,
        deliveryState: "sending",
      };
      setMessages((prev) => [...prev, optimistic]);
      const entry: OutboxEntry = {
        localId: optimistic.id,
        clientMessageId,
        text: trimmed,
        target: conversationIdRef.current,
        firstSentAt: Date.now(),
        autoResends: 0,
        attempt: 0,
        inFlight: false,
        refused: false,
      };
      outboxRef.current.set(entry.localId, entry);
      transmit(entry, sock, true);
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = setTimeout(() => setIsLoading(false), 5000);
      return true;
    },
    [transmit]
  );

  const retryMessage = useCallback(
    (localId: string, confirmed = false): RetryResult => {
      const entry = outboxRef.current.get(localId);
      if (!entry) return "unavailable";
      if (statusRef.current === "resolved") {
        setError(CLOSED);
        return "unavailable";
      }
      const sock = socketRef.current;
      if (!sock?.connected || !attachedRef.current) {
        setError(NOT_CONNECTED);
        return "unavailable";
      }
      const kind = retryKind(entry, conversationIdRef.current, Date.now());
      if (kind === "confirm" && !confirmed) return "confirm";
      if (kind !== "same-id") {
        // A new message: new id, into the conversation on screen now.
        const clientMessageId = newClientMessageId();
        entry.clientMessageId = clientMessageId;
        entry.target = conversationIdRef.current;
        entry.firstSentAt = Date.now();
        entry.autoResends = 0;
        entry.refused = false;
        setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, clientMessageId, timestamp: new Date() } : m)));
      }
      setError(null);
      transmit(entry, sock, false);
      return "sent";
    },
    [transmit]
  );

  const removeMessage = useCallback((localId: string) => {
    outboxRef.current.delete(localId);
    setMessages((prev) => prev.filter((m) => !(m.id === localId && m.deliveryState)));
  }, []);

  const notifyTyping = useCallback(() => {
    const sock = socketRef.current;
    if (!sock?.connected || !conversationIdRef.current) return;
    if (statusRef.current === "resolved") return;
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      sock.emit("support:typing", {
        conversationId: conversationIdRef.current,
        isTyping: true,
      });
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      typingActiveRef.current = false;
      if (!conversationIdRef.current) return;
      socketRef.current?.emit("support:typing", {
        conversationId: conversationIdRef.current,
        isTyping: false,
      });
    }, 2000);
  }, []);

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
  // resolved-unrated conversation, we wait for the rating-dismissed ack
  // before emitting `support:start` — otherwise an older server's
  // onUserConnect re-finds the still-unrated conversation and replays the
  // rating prompt (the Skip button "doesn't advance" race). Current servers
  // run both in order anyway.
  const startNewConversation = useCallback(() => {
    const sock = socketRef.current;
    if (!sock?.connected) return;
    const wasAwaitingRating = statusRef.current === "resolved" && awaitingRating;
    const conversationId = conversationIdRef.current;

    resetConversationState();
    // Hold events until the new join, like a fresh connection.
    attachedRef.current = false;

    if (wasAwaitingRating && conversationId) {
      sock.emit("support:rating-dismissed", { conversationId }, () => {
        // Even if the ack errored, still try to start a new convo —
        // the user has unambiguously asked to move on.
        if (socketRef.current === sock) sock.emit("support:start", {});
      });
    } else {
      sock.emit("support:start", {});
    }
  }, [awaitingRating, resetConversationState]);

  const forget = useCallback(() => {
    disconnect();
    resetConversationState();
    clearLoading();
    setError(null);
  }, [disconnect, resetConversationState, clearLoading]);

  const pendingCount = messages.reduce((n, m) => (m.deliveryState ? n + 1 : n), 0);

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
    joined,
    pendingCount,
    connect,
    disconnect,
    sendMessage,
    retryMessage,
    removeMessage,
    notifyTyping,
    submitRating,
    dismissRating,
    startNewConversation,
    forget,
  };
}
