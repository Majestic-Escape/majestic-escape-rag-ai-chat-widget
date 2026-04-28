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
  const aiHistoryLoadedRef = useRef(false);

  const loadAiHistoryOnce = useCallback(async () => {
    if (aiHistoryLoadedRef.current) return;
    aiHistoryLoadedRef.current = true;
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
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages?: Array<{
          role: "user" | "model";
          text: string;
          createdAt: string;
          properties?: PropertyCardData[];
        }>;
      };
      const rows = data.messages ?? [];
      if (rows.length === 0) return;
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
        });

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
        console.error("Chat error:", err);
        setError("I'm having trouble connecting right now. Please try again.");
        setActive((prev) => prev.filter((m) => m.id !== modelMsgId));
      } finally {
        setIsLoading(false);
      }
    },
    [aiMessages, supportMessages]
  );

  const resetAiMessages = useCallback(() => {
    setAiMessages([AI_GREETING]);
    aiHistoryLoadedRef.current = true;
  }, []);

  return {
    aiMessages,
    supportMessages,
    isLoading,
    error,
    sendMessage,
    initChat,
    resetAiMessages,
  };
}
