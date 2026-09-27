import { useState, useCallback, useEffect, useRef } from "react";
import { Message, ChatMode, PropertyCardData } from "./types";
import { getAuthToken, getBackendUrl, getOrCreateGuestId } from "./utils";

const AI_GREETING: Message = {
  id: "init-ai",
  role: "model",
  text: "Hi there! I'm Majestic AI ✨ — here to help you find the perfect stay or answer questions about your booking. What are you looking for?",
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

  const loadAiHistoryOnce = useCallback(async () => {
    if (aiHistoryLoadedRef.current) return;
    aiHistoryLoadedRef.current = true;
    const gen = historyGenRef.current;
    try {
      const token = getAuthToken();
      const guestSessionId = token ? null : getOrCreateGuestId();
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
      };
      const rows = data.messages ?? [];
      if (gen !== historyGenRef.current || rows.length === 0) return;
      setAiMessages((prev) => {
        if (prev.length > 1) return prev;
        const restored: Message[] = rows.map((r, i) => ({
          id: `restored-${i}-${r.createdAt}`,
          role: r.role,
          text: r.text,
          timestamp: new Date(r.createdAt),
          isSupport: false,
          ...(r.properties && r.properties.length > 0 ? { properties: r.properties } : {}),
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
    async (text: string, mode: ChatMode) => {
      if (!text.trim()) return;

      const isAi = mode === "ai";
      const setActive = isAi ? setAiMessages : setSupportMessages;
      const activeMessages = isAi ? aiMessages : supportMessages;

      const userMsg: Message = {
        id: `${mode}-${Date.now()}`,
        role: "user",
        text: text.trim(),
        timestamp: new Date(),
        isSupport: !isAi,
      };

      const historyForApi = activeMessages
        .filter((m) => !m.id.startsWith("init-"))
        .map((m) => ({ role: m.role, text: m.text }));

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
        const guestSessionId = token ? null : getOrCreateGuestId();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetch(`${getBackendUrl()}/api/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            message: text.trim(),
            history: historyForApi,
            mode,
            guestSessionId,
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
        }
      }
    },
    [aiMessages, supportMessages]
  );

  const resetAiMessages = useCallback(() => {
    setAiMessages([AI_GREETING]);
    aiHistoryLoadedRef.current = true;
    setAiHistoryReady(true);
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
  };
}
