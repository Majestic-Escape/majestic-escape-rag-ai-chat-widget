import { useState, useCallback, useEffect, useRef } from "react";
import { Message, ChatMode, PropertyCardData, FilterChip, FilterOp, SearchFilters, Draft } from "./types";
import { getAuthToken, getBackendUrl, getOrCreateGuestId } from "./utils";

const AI_GREETING: Message = {
  id: "init-ai",
  role: "model",
  text: "Hi there! I'm Majestic AI ✨ I'll help you find the perfect stay.",
  timestamp: new Date(),
  isSupport: false,
};

const SUPPORT_GREETING: Message = {
  id: "init-support",
  role: "model",
  text: "Hi! You've reached Majestic Support. Share your booking reference or describe your issue and our team will get back to you shortly.",
  timestamp: new Date(),
  isSupport: true,
};

export function useChat() {
  const [aiMessages, setAiMessages] = useState<Message[]>([]);
  const [supportMessages, setSupportMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when /api/chat answers 403 ai_disabled — the ops kill-switch was flipped
  // while this page was open. ChatWidget watches this and hides the AI tab.
  const [aiDisabled, setAiDisabled] = useState(false);
  // The saved conversation has been looked up (found, empty or failed). Until
  // then the widget holds back the starter prompts, which a restored
  // conversation would replace a moment later.
  const [aiHistoryReady, setAiHistoryReady] = useState(false);
  const aiHistoryLoadedRef = useRef(false);
  // Bumped by forgetAi(), so a lookup still in flight for the previous person
  // can't land in the next one's conversation.
  const historyGenRef = useRef(0);
  // The reply being streamed, so forgetAi() can stop it.
  const replyRef = useRef<AbortController | null>(null);
  // The "Start fresh" request still on its way to the server, if any.
  const resetRef = useRef<Promise<void> | null>(null);
  // What the assistant says it is doing while a reply is on its way ("Searching stays…").
  const [aiStatus, setAiStatus] = useState<string | null>(null);

  const loadAiHistoryOnce = useCallback(async () => {
    if (aiHistoryLoadedRef.current) return;
    aiHistoryLoadedRef.current = true;
    const gen = historyGenRef.current;
    try {
      const token = getAuthToken();
      // Sent with a token too (as when sending): an expired token falls back to the guest id on the server.
      const guestSessionId = getOrCreateGuestId();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const params = new URLSearchParams();
      if (guestSessionId) params.set("guestSessionId", guestSessionId);
      params.set("limit", "50");
      const res = await fetch(`${getBackendUrl()}/api/chat/history?${params.toString()}`, {
        headers,
      });
      if (gen !== historyGenRef.current || !res.ok) return;
      const data = (await res.json()) as {
        messages?: Array<{
          role: "user" | "model";
          text: string;
          createdAt: string;
          properties?: PropertyCardData[];
        }>;
        /** Filters mode: the current search, shown as the newest restored reply's chips. */
        search?: SearchFilters;
        filters?: FilterChip[];
      };
      const rows = data.messages ?? [];
      if (gen !== historyGenRef.current || rows.length === 0) return;
      const newestReply = rows.map((r) => r.role).lastIndexOf("model");
      setAiMessages((prev) => {
        if (prev.length > 1) return prev;
        // the saved text keeps its filters line; where the chips are shown, drop that line (it would say it twice)
        const filtersLine = data.filters?.map((c) => c.label).join(" · ");
        const restored: Message[] = rows.map((r, i) => ({
          id: `restored-${i}-${r.createdAt}`,
          role: r.role,
          text: i === newestReply && filtersLine && data.search ? r.text.split("\n").filter((l) => l !== filtersLine).join("\n") || r.text : r.text,
          timestamp: new Date(r.createdAt),
          isSupport: false,
          ...(r.properties && r.properties.length > 0 ? { properties: r.properties } : {}),
          ...(i === newestReply && data.search && Array.isArray(data.filters) ? { search: data.search, filters: data.filters } : {}),
        }));
        return [AI_GREETING, ...restored];
      });
    } catch {
      /* silent — non-critical */
    } finally {
      if (gen === historyGenRef.current) setAiHistoryReady(true);
    }
  }, []);

  const initChat = useCallback(
    (mode: ChatMode) => {
      if (mode === "ai") {
        setAiMessages((prev) => (prev.length === 0 ? [AI_GREETING] : prev));
        void loadAiHistoryOnce();
      } else {
        setSupportMessages((prev) => (prev.length === 0 ? [SUPPORT_GREETING] : prev));
      }
    },
    [loadAiHistoryOnce]
  );

  useEffect(() => {
    const onStorage = () => {
      aiHistoryLoadedRef.current = false;
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const sendMessage = useCallback(
    // `op`: a filter chip the customer removed — the server applies it as it is.
    // `quick`: a quick-answer button ("Yes, show them"); the server answers it without a model.
    async (text: string, mode: ChatMode, op?: FilterOp, quick?: boolean) => {
      if (!text.trim()) return;

      const isAi = mode === "ai";
      const setActive = isAi ? setAiMessages : setSupportMessages;

      const userMsg: Message = {
        id: `${mode}-${Date.now()}`,
        role: "user",
        text: text.trim(),
        timestamp: new Date(),
        isSupport: !isAi,
      };

      setActive((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setError(null);

      const modelMsgId = `${mode}-${Date.now() + 1}`;
      const modelMsg: Message = {
        id: modelMsgId,
        role: "model",
        text: "",
        timestamp: new Date(),
        isSupport: !isAi,
      };
      setActive((prev) => [...prev, modelMsg]);

      replyRef.current?.abort();
      const reply = new AbortController();
      replyRef.current = reply;
      try {
        const token = getAuthToken();
        // Always sent: the server ignores it for a valid sign-in, and falls back to it
        // when the token has expired — otherwise that visitor would have no memory at all.
        const guestSessionId = getOrCreateGuestId();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;

        await resetRef.current;
        const res = await fetch(`${getBackendUrl()}/api/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            // No history is sent: the server keeps the search it understood so far,
            // per signed-in person or guest id.
            message: text.trim(),
            mode,
            guestSessionId,
            // This bundle understands `[META]` lines (status, filter chips, headings) and, since caps 2, the
            // filter editor, drafts and quick answers.
            caps: 2,
            ...(op ? { op } : {}),
            ...(quick ? { quick: true } : {}),
          }),
          signal: reply.signal,
        });

        // Ops flipped the kill-switch while this page was open. /embed/widget.js
        // is cached for up to 5 minutes, so a tab loaded before the flip can
        // still be showing the AI tab. Detect that specific 403 and tell
        // ChatWidget to hide the tab, rather than leaving the user on a generic
        // "trouble connecting" error that invites them to retry forever.
        if (res.status === 403) {
          let disabled = false;
          try {
            disabled = (await res.clone().json())?.error === "ai_disabled";
          } catch {
            /* non-JSON 403 → fall through to the generic error path below */
          }
          if (disabled) {
            setAiDisabled(true);
            setActive((prev) => prev.filter((m) => m.id !== modelMsgId));
            return; // `finally` still clears isLoading
          }
        }

        // Our own limits: say which one, not "trouble connecting" (which invites retrying at once).
        if (res.status === 429) {
          const why = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
          setError(typeof why === "string" ? why : "Too many requests, please slow down.");
          setActive((prev) => prev.filter((m) => m.id !== modelMsgId));
          return; // `finally` still clears isLoading
        }
        if (!res.ok || !res.body) throw new Error("Network error");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);

            if (payload === "[DONE]") continue;

            if (payload.startsWith("[PROPS]")) {
              try {
                const props: PropertyCardData[] = JSON.parse(payload.slice(7));
                setActive((prev) =>
                  prev.map((m) => (m.id === modelMsgId ? { ...m, properties: props } : m))
                );
              } catch {
                /* malformed payload — ignore */
              }
              continue;
            }

            if (payload.startsWith("[META]")) {
              try {
                const meta = JSON.parse(payload.slice(6)) as {
                  status?: string; filters?: FilterChip[]; heading?: string | null;
                  search?: SearchFilters; draft?: Draft; controls?: { draft: boolean }; quick?: string[];
                };
                if (typeof meta.status === "string") setAiStatus(meta.status);
                if (Array.isArray(meta.filters)) {
                  setActive((prev) =>
                    prev.map((m) =>
                      m.id === modelMsgId
                        ? {
                            ...m,
                            filters: meta.filters,
                            heading: meta.heading ?? null,
                            ...(meta.search && typeof meta.search === "object" ? { search: meta.search } : {}),
                            ...(meta.draft && Array.isArray(meta.draft.lines) ? { draft: meta.draft } : {}),
                            ...(meta.controls ? { controls: meta.controls } : {}),
                            ...(Array.isArray(meta.quick) ? { quick: meta.quick.filter((q) => typeof q === "string") } : {}),
                          }
                        : m
                    )
                  );
                }
              } catch {
                /* malformed payload — ignore */
              }
              continue;
            }

            const chunk = payload.replace(/\\n/g, "\n");
            setActive((prev) =>
              prev.map((m) =>
                m.id === modelMsgId ? { ...m, text: m.text + chunk } : m
              )
            );
          }
        }
      } catch (err) {
        if (reply.signal.aborted) return; // forgotten: its conversation is gone
        console.error("Chat error:", err);
        setError("I'm having trouble connecting right now. Please try again.");
        setActive((prev) => prev.filter((m) => m.id !== modelMsgId));
      } finally {
        if (replyRef.current === reply) {
          replyRef.current = null;
          setIsLoading(false);
          setAiStatus(null);
        }
      }
    },
    []
  );

  const resetAiMessages = useCallback(() => {
    setAiMessages([AI_GREETING]);
    aiHistoryLoadedRef.current = true;
    setAiHistoryReady(true);
    // Clear the search the server remembers too, or the next message would
    // quietly inherit the old place, dates and budget.
    // The next message waits for it (resetRef), so the reset can never land after it.
    const token = getAuthToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    resetRef.current = fetch(`${getBackendUrl()}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "new search", mode: "ai", guestSessionId: getOrCreateGuestId(), reset: true, caps: 2 }),
    }).then(
      () => undefined,
      () => undefined
    );
  }, []);

  // The signed-in person changed: drop their conversation, and look the next
  // person's up afresh on the next initChat.
  const forgetAi = useCallback(() => {
    historyGenRef.current++;
    aiHistoryLoadedRef.current = false;
    // a reply still streaming for them: stop it, or the next person waits it out
    replyRef.current?.abort();
    replyRef.current = null;
    setIsLoading(false);
    setAiMessages([]);
    setAiHistoryReady(false);
    setError(null);
  }, []);

  return {
    aiMessages,
    supportMessages,
    isLoading,
    error,
    aiDisabled,
    sendMessage,
    initChat,
    resetAiMessages,
    aiHistoryReady,
    forgetAi,
    aiStatus,
  };
}
