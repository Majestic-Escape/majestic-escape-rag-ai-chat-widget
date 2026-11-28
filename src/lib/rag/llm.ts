// The only place the search pipeline talks to a model.
//
// Rules:
//  • A request makes at most TWO attempts that can take time, on two different
//    entries of the configured chain. The second fires on ANY failure of the first
//    (a retired model answers 404, not 429). A rate-limit refusal (429) comes back
//    at once and does not use up an attempt, so a chain whose first models are out
//    of quota still reaches the next one.
//  • Only the models named in the chain are ever called. Nothing here discovers,
//    upgrades to, or falls back on another model or endpoint by itself.
//  • Quota-aware: each chain entry has a small in-memory circuit breaker. A
//    rate-limit answer opens it for as long as the provider says (or a default);
//    repeated failures open it briefly; "model not found / not allowed" opens
//    it for a long time. An open entry is skipped WITHOUT spending an attempt,
//    so a provider that is out of quota costs no latency.
//  • Every attempt is reserved against the daily cap first, has its own
//    timeout, and stops when the request's own signal does.
// Output is JSON text only; the caller validates it.
//
// Plain fetch on purpose: every provider is one POST, and a fake `fetch` is all
// a test needs. Claude goes through the official SDK, given the same `fetch`.

import Anthropic from "@anthropic-ai/sdk";
import { DB_WAIT_MS, bounded } from "../bounded";

const OPENAI_COMPATIBLE = {
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
} as const;
type OpenAiKind = keyof typeof OPENAI_COMPATIBLE;

export interface Provider {
  /** "gemini" = Google Generative Language API; "anthropic" = Claude (official SDK); the others = OpenAI-compatible APIs (OPENAI_COMPATIBLE). */
  kind: "gemini" | "anthropic" | OpenAiKind;
  model: string;
  key: string;
}

export interface Health {
  /** Chain entry id → do not call before this time (ms). */
  openUntil: Map<string, number>;
  failures: Map<string, number>;
}
export const newHealth = (): Health => ({ openUntil: new Map(), failures: new Map() });
/** One per process: quota state is only useful if it outlives a request. */
const processHealth = newHealth();

export interface LlmConfig {
  /** Ordered. The first two AVAILABLE entries are the attempt and its fallback. */
  chain: Provider[];
  fetch: typeof fetch;
  /** Counts one attempt toward the daily cap; false = cap reached. */
  reserve: () => Promise<boolean>;
  /** Best-effort usage accounting. tokensIn includes cacheRead and cacheWrite (billed at 0.1x and 1.25x on Claude). */
  record?: (u: { provider: string; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }) => void;
  health?: Health;
  now?: () => number;
}

export type LlmResult =
  | { ok: true; json: unknown; provider: string; tokensIn: number; tokensOut: number; attempts: number; ms: number; cacheRead?: number; cacheWrite?: number }
  /** "unavailable" = every entry's breaker is open (quota); nothing was spent. */
  | { ok: false; why: "cap" | "failed" | "unconfigured" | "unavailable"; attempts: number; errors: string[]; retryAfterMs?: number };

export const providerId = (p: Provider) => `${p.kind}:${p.model}`;

const ATTEMPT_TIMEOUT_MS = [3500, 3000];
const MAX_OUTPUT_TOKENS = 500;
// billing: out of credit or over a spend limit. Nothing a retry can fix until someone pays, so the entry rests long
// enough that guests get the filter-buttons answer at once, and short enough that a refill is picked up soon after.
const COOLDOWN = { rateLimited: 60_000, flaky: 30_000, notAllowed: 10 * 60_000, billing: 10 * 60_000 };
const FLAKY_AFTER = 3;

/** billing: credit or spend limit. overloaded: the provider says so (529). content: this request's own answer was
 *  unusable (a refusal); says nothing about the provider's health, so it never opens the breaker. */
type FailureKind = "billing" | "overloaded" | "content" | "other";

class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number, readonly kind: FailureKind = "other") {
    super(message);
  }
}

// Stable codes from the API's error body (error.details.error_code), never its wording.
const SPEND_CODES = new Set(["enforced_spend_limit_reached", "contract_spend_limit_reached", "linked_organization_spend_limit_reached", "linked_organization_billing_unavailable"]);
/** How a failed call reads: an HTTP status plus, from Claude's API, the error type and code. */
export function failureKind(status: number, type?: string | null, code?: string | null, message?: string | null): FailureKind {
  if (status === 402 || type === "billing_error" || (code && SPEND_CODES.has(code))) return "billing";
  // shortcut: the older "credit balance is too low" answer was a 400 with only a message; drop when no longer seen.
  if (status === 400 && /credit balance/i.test(message ?? "")) return "billing";
  if (status === 529 || type === "overloaded_error") return "overloaded";
  if (status === 422) return "content";
  return "other";
}

/** tokensIn counts every input token; cacheRead / cacheWrite say how many of them came from / went to the prompt cache. */
type Out = { text: string; tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number };

async function callGemini(system: string, user: string, p: Provider, f: typeof fetch, signal: AbortSignal): Promise<Out> {
  const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": p.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS, responseMimeType: "application/json" },
    }),
    signal,
  });
  if (!res.ok) {
    // 429 bodies carry `details[].retryDelay` like "37s".
    const body = (await res.json().catch(() => null)) as { error?: { details?: { retryDelay?: string }[] } } | null;
    const delay = body?.error?.details?.map((d) => d.retryDelay).find((d) => typeof d === "string");
    throw new ProviderError(`gemini ${res.status}`, res.status, delay ? Math.ceil(parseFloat(delay) * 1000) : undefined, failureKind(res.status));
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  return {
    text: (data.candidates?.[0]?.content?.parts ?? []).map((x) => x.text ?? "").join(""),
    tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}


async function callOpenAiCompatible(system: string, user: string, p: Provider, f: typeof fetch, signal: AbortSignal): Promise<Out> {
  // The gpt-oss models reason before answering; without a low effort the
  // reasoning can use the whole output budget and JSON mode returns nothing.
  const budget = p.model.includes("gpt-oss") ? { reasoning_effort: "low", max_completion_tokens: 1500 } : { max_tokens: MAX_OUTPUT_TOKENS };
  const res = await f(`${OPENAI_COMPATIBLE[p.kind as OpenAiKind]}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0,
      response_format: { type: "json_object" },
      ...budget,
    }),
    signal,
  });
  if (!res.ok) {
    const after = Number(res.headers.get("retry-after"));
    throw new ProviderError(`${p.kind} ${res.status}`, res.status, Number.isFinite(after) && after > 0 ? Math.ceil(after * 1000) : undefined, failureKind(res.status));
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return { text: data.choices?.[0]?.message?.content ?? "", tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0 };
}

/** Claude through the official SDK. No SDK retries: the chain owns the fallback and the deadline. */
async function callAnthropic(system: string, user: string, p: Provider, f: typeof fetch, signal: AbortSignal): Promise<Out> {
  const client = new Anthropic({ apiKey: p.key, fetch: f, maxRetries: 0 });
  try {
    const msg = await client.messages.create(
      {
        model: p.model,
        max_tokens: 1000,
        // A short structured reading under a 9 s deadline: no thinking (allowed at the default effort).
        thinking: { type: "disabled" },
        // The instructions are the same bytes on every call (today's date and the message are in the user turn),
        // so they are cached: a read costs 0.1x the input price, and the 5-minute entry is refreshed by every hit.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
      },
      { signal }
    );
    // A declined request is a failure of this attempt; the next chain entry answers.
    if (msg.stop_reason === "refusal") throw new ProviderError("anthropic refusal", 422, undefined, "content");
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = msg.usage.cache_creation_input_tokens ?? 0;
    return { text, tokensIn: msg.usage.input_tokens + cacheRead + cacheWrite, tokensOut: msg.usage.output_tokens, cacheRead, cacheWrite };
  } catch (err) {
    if (err instanceof Anthropic.APIError && typeof err.status === "number") {
      const after = Number(err.headers?.get("retry-after"));
      const kind = failureKind(err.status, err.type, err.errorCode, err.apiMessage);
      throw new ProviderError(`anthropic ${err.status}${err.errorCode ? ` ${err.errorCode}` : err.type ? ` ${err.type}` : ""}`, err.status, Number.isFinite(after) && after > 0 ? Math.ceil(after * 1000) : undefined, kind);
    }
    throw err;
  }
}

/** Some models wrap JSON in a code fence despite being asked not to. */
function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(t);
}

/** How long to stay away from an entry after this failure (0 = keep using it). */
function cooldownFor(err: unknown, failures: number): number {
  if (err instanceof ProviderError) {
    if (err.kind === "billing") return COOLDOWN.billing; // before 429: a spend-limit 429 has no retry-after
    if (err.status === 429) return Math.min(err.retryAfterMs ?? COOLDOWN.rateLimited, 15 * 60_000);
    if (err.status === 401 || err.status === 403 || err.status === 404) return COOLDOWN.notAllowed;
    if (err.kind === "overloaded") return COOLDOWN.flaky;
  }
  return failures >= FLAKY_AFTER ? COOLDOWN.flaky : 0;
}

/** This request's own answer was unusable (a refusal, text that is not JSON): no sign the provider is unwell, and
 *  counting it would let one guest's messages pause the model for everyone. */
const isContentFailure = (err: unknown) => err instanceof SyntaxError || (err instanceof ProviderError && err.kind === "content");

export async function proposeJson(system: string, user: string, cfg: LlmConfig, signal: AbortSignal): Promise<LlmResult> {
  if (cfg.chain.length === 0) return { ok: false, why: "unconfigured", attempts: 0, errors: [] };
  const health = cfg.health ?? processHealth;
  const now = cfg.now ?? Date.now;

  const open = (p: Provider) => (health.openUntil.get(providerId(p)) ?? 0) > now();
  const available = cfg.chain.filter((p) => !open(p));
  if (available.length === 0) {
    const soonest = Math.min(...cfg.chain.map((p) => health.openUntil.get(providerId(p)) ?? 0));
    return { ok: false, why: "unavailable", attempts: 0, errors: ["every provider is cooling down"], retryAfterMs: Math.max(0, soonest - now()) };
  }

  const errors: string[] = [];
  let attempts = 0; // calls made, rate-limit refusals included
  let timed = 0; // calls that could take time: at most two
  for (const p of available) {
    if (signal.aborted || timed >= 2) break;
    // an unanswered counter refuses the call, like an unreadable one
    if (!(await bounded(cfg.reserve(), DB_WAIT_MS, signal).catch(() => false))) return { ok: false, why: "cap", attempts, errors };
    attempts++;
    const id = providerId(p);
    const started = now();
    try {
      const call = p.kind === "gemini" ? callGemini : p.kind === "anthropic" ? callAnthropic : callOpenAiCompatible;
      const out = await call(system, user, p, cfg.fetch, AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS[timed]!)]));
      const json = parseJson(out.text); // unusable output counts as a failure of this attempt
      health.failures.delete(id);
      cfg.record?.({ provider: id, tokensIn: out.tokensIn, tokensOut: out.tokensOut, cacheRead: out.cacheRead ?? 0, cacheWrite: out.cacheWrite ?? 0 });
      return { ok: true, json, provider: id, tokensIn: out.tokensIn, tokensOut: out.tokensOut, attempts, ms: now() - started, ...(out.cacheRead !== undefined ? { cacheRead: out.cacheRead, cacheWrite: out.cacheWrite } : {}) };
    } catch (err) {
      if (signal.aborted) break; // the customer left: not the provider's fault
      if (!isContentFailure(err)) {
        const failures = (health.failures.get(id) ?? 0) + 1;
        health.failures.set(id, failures);
        const cool = cooldownFor(err, failures);
        if (cool > 0) {
          health.openUntil.set(id, now() + cool);
          health.failures.delete(id);
          // the operator's signal that credit ran out: drafting answers "use the filter buttons" until the pause ends
          if (err instanceof ProviderError && err.kind === "billing") console.warn(`[llm] ${id}: ${err.message}: paused ${Math.round(cool / 60_000)} min (check credit / spend limit)`);
        }
      }
      if (!(err instanceof ProviderError && err.status === 429)) timed++;
      errors.push(`${id}: ${(err as Error).message}`.slice(0, 120));
    }
  }
  return { ok: false, why: "failed", attempts, errors };
}

/** "gemini:gemini-flash-lite-latest,groq:qwen/qwen3.8-27b" → chain entries that have a key. */
// Hindi and Hinglish messages can go to the chain that reads them best (LLM_CHAIN_HINGLISH).
// A message counts as Hindi / Hinglish when it has Devanagari or one word that is never English.
const DEVANAGARI = /[ऀ-ॿ]/;
const HINGLISH = new Set([
  "hai", "hain", "mein", "chahiye", "chaiye", "chahie", "liye", "nahi", "nahin", "nhi", "wala", "wali", "wale", "waala", "kya", "dikhao", "batao",
  "hazaar", "hazar", "hajar", "logon", "logo", "raat", "kamra", "kamre", "rukna", "bade", "bacche", "baccha", "bachche", "sasta", "saste", "accha", "achha",
  "kuch", "koi", "karo", "chalega", "jagah", "ghar", "aur", "bhi", "tak", "zyada", "jyada", "paas", "milega", "hoga", "hona", "dono", "isse", "abhi", "sirf", "yaar",
]);
export function isHindiOrHinglish(message: string): boolean {
  return DEVANAGARI.test(message) || message.toLowerCase().split(/[^a-z]+/).some((w) => HINGLISH.has(w));
}
/** The chain for this message: the Hindi / Hinglish one when configured and the message is one. */
export function routeChain(message: string, main: Provider[], hinglish: Provider[] | null): Provider[] {
  return hinglish && hinglish.length && isHindiOrHinglish(message) ? hinglish : main;
}

/** API keys by provider kind, read when called (never at module load). */
export const envKeys = (): Partial<Record<Provider["kind"], string>> => ({
  gemini: process.env.GEMINI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  groq: process.env.GROQ_API_KEY,
  xai: process.env.XAI_API_KEY,
  cerebras: process.env.CEREBRAS_API_KEY,
  nvidia: process.env.NVIDIA_API_KEY,
});

export function parseChain(spec: string, keys: Partial<Record<Provider["kind"], string>>): Provider[] {
  const out: Provider[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = part.indexOf(":");
    const kind = part.slice(0, at);
    const model = part.slice(at + 1);
    if ((kind === "gemini" || kind === "anthropic" || Object.hasOwn(OPENAI_COMPATIBLE, kind)) && model && keys[kind as Provider["kind"]]) out.push({ kind: kind as Provider["kind"], model, key: keys[kind as Provider["kind"]]! });
  }
  return out;
}
