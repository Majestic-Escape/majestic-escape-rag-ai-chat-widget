// Production wiring for the search pipeline: environment, MongoDB, real fetch.
// Every `process.env` read is inside a function (see CLAUDE.md: Railway does
// not expose user env vars at build time, and module-scope reads break the
// precompiled server bundle's load order).

import { ObjectId } from "mongodb";
import clientPromise, { appDbName } from "../mongodb";
import { verifyToken } from "../jwt";
import { ipFromHeaders } from "../rateLimit";
import { istToday } from "./dates";
import { envKeys, parseChain, proposeJson, routeChain } from "./llm";
import type { PipelineDeps } from "./pipeline";
import { guestIdForUnverifiedToken, mongoStore, stateKey } from "./state";

export type PipelineMode = "safe" | "shadow" | "v2";

/** `safe` unless explicitly switched: a deploy never turns the new search on by itself. */
export function pipelineMode(): PipelineMode {
  const m = process.env.RAG_PIPELINE;
  return m === "v2" || m === "shadow" ? m : "safe";
}

/** How a typed message is used when the pipeline is live. `filters` (default): the guest sets the search with
 *  controls; a typed message is at most a draft they confirm. `chat`: the model's reading is applied directly
 *  (held to the 98 % follow-up / 95 % Hindi-Hinglish gates, not met on 2026-11-27). */
export function searchMode(): "filters" | "chat" {
  return process.env.RAG_SEARCH_MODE === "chat" ? "chat" : "filters";
}
/** Filters mode only: a typed message becomes an editable draft (needs a model). Off unless switched on. */
export const aiDraftEnabled = (): boolean => process.env.RAG_AI_DRAFT === "on";
/** Dates are sent to the site's search only when switched on (off until the A9 search-vs-booking fix is live). */
export const datedSearchEnabled = (): boolean => process.env.RAG_DATED_SEARCH === "on";

/** RAG_V2_PERCENT as a number; unset = 100, unreadable ("10%", "ten") = 0: it must never mean everyone. */
export function canaryPercent(): number {
  const raw = process.env.RAG_V2_PERCENT;
  const pct = raw === undefined || raw === "" ? 100 : Number(raw);
  return Number.isNaN(pct) ? 0 : pct;
}

/** Share of identities that get `v2` when the mode is `v2` (canary). Stable per identity. */
export function inCanary(identity: string): boolean {
  const pct = canaryPercent();
  if (pct >= 100) return true;
  let h = 0;
  for (let i = 0; i < identity.length; i++) h = (h * 31 + identity.charCodeAt(i)) >>> 0;
  return h % 100 < Math.max(0, pct);
}

export interface ChatIdentity { userId: string | null; guestId: string | null; key: string | null; ip: string }

/** Who is asking, derived one way for /api/chat, /api/chat/history and /api/chat/config, so the three agree on
 *  the canary and on whose search state is read. A token that does not verify gets a guest id of its own. */
export function chatIdentity(headers: Headers, guestRaw: unknown): ChatIdentity {
  const auth = headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const jwt = bearer ? verifyToken(bearer) : null;
  const claimed = typeof jwt?.userId === "string" ? jwt.userId : typeof jwt?.id === "string" ? jwt.id : null;
  // A signed token whose id is not an ObjectId is treated as anonymous, not as a crash.
  const userId = claimed && ObjectId.isValid(claimed) && claimed.length === 24 ? claimed : null;
  const guestId = !userId && typeof guestRaw === "string" && guestRaw.length <= 100 ? (bearer ? guestIdForUnverifiedToken(guestRaw, bearer) : guestRaw) : null;
  return { userId, guestId, key: stateKey(userId, guestId), ip: ipFromHeaders(headers) };
}

/** The pilot answers this identity. Everyone else gets the safe reply, so nothing of the pilot (filter
 *  controls, search state) may be offered to them either. */
export const pilotLive = (id: Pick<ChatIdentity, "key" | "ip">): boolean => pipelineMode() === "v2" && inCanary(id.key ?? id.ip);

export async function productionDeps(): Promise<PipelineDeps> {
  const db = (await clientPromise).db(appDbName());
  const usage = db.collection<{ _id: string; attempts?: number; tokensIn?: number; tokensOut?: number; createdAt?: Date }>("ai_usage");
  const cap = Number(process.env.DAILY_AI_LIMIT_GLOBAL ?? "3000");

  // The daily cap lives in the database so a restart or a second instance
  // cannot reset it. An unreadable counter refuses the call: this guards a bill.
  const reserve = async (): Promise<boolean> => {
    try {
      const doc = await usage.findOneAndUpdate(
        { _id: istToday(new Date()) },
        { $inc: { attempts: 1 }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: "after", maxTimeMS: 1500 }
      );
      return (doc?.attempts ?? 1) <= cap;
    } catch {
      return false;
    }
  };
  const record = (u: { tokensIn: number; tokensOut: number }) => {
    void usage
      .updateOne({ _id: istToday(new Date()) }, { $inc: { tokensIn: u.tokensIn, tokensOut: u.tokensOut } })
      .catch(() => {});
  };

  return {
    now: () => new Date(),
    store: mongoStore(db.collection("ai_chat_state")),
    catalog: {
      baseUrl: process.env.CATALOG_API_URL ?? "https://server.majesticescape.in/api/v1",
      fetch,
    },
    llm: (system, user, signal) =>
      proposeJson(
        system,
        user,
        {
          // Only the models named here are ever called; nothing switches to another
          // model or to a paid endpoint by itself. Entries without a key are dropped.
          // LLM_CHAIN_HINGLISH (optional): Hindi / Hinglish messages use that chain instead.
          chain: routeChain(
            String((JSON.parse(user) as { message?: unknown }).message ?? ""),
            parseChain(process.env.LLM_CHAIN ?? DEFAULT_CHAIN, envKeys()),
            // the default routing only when no chain is configured at all: a configured LLM_CHAIN alone means one chain
            parseChainOrNull(process.env.LLM_CHAIN_HINGLISH ?? (process.env.LLM_CHAIN ? undefined : DEFAULT_CHAIN_HINGLISH))
          ),
          fetch,
          reserve,
          record,
        },
        signal
      ),
  };
}

/** The proposed production routing (candidate 3, eval/README.md): English GPT-OSS 120B then Qwen 3.8 27B,
 *  Hindi / Hinglish the reverse. Groq only: its terms bar training on inputs and keep none by default;
 *  Gemini's unpaid tier allows human review of inputs, and xAI is a paid account, so neither is in the
 *  default. Each Groq model has its own daily quota, so the second also covers the first running out. */
export const DEFAULT_CHAIN = "groq:openai/gpt-oss-120b,groq:qwen/qwen3.8-27b";
export const DEFAULT_CHAIN_HINGLISH = "groq:qwen/qwen3.8-27b,groq:openai/gpt-oss-120b";
const parseChainOrNull = (spec: string | undefined) => (spec ? parseChain(spec, envKeys()) : null);
