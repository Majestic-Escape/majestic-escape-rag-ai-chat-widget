// Lightweight moderation layer for chat inputs and outputs.
// Keep dependency-free — runs on every chat request.

export const MAX_MESSAGE_CHARS = 2000;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateUserMessage(text: unknown): ValidationResult {
  if (typeof text !== "string") return { ok: false, reason: "Message must be a string" };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "Message is empty" };
  if (trimmed.length > MAX_MESSAGE_CHARS)
    return { ok: false, reason: `Message exceeds ${MAX_MESSAGE_CHARS} characters` };
  return { ok: true };
}

// Strip ASCII control bytes (NUL, BEL, etc.) that can corrupt logs or downstream
// systems. Preserve common whitespace (\t, \n, \r) since multi-line messages are
// legitimate. Run on every user-supplied string before persisting.
export function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// Conservative heuristic — flags messages that look like attempts to override
// the system prompt or extract it. Best-effort: false positives are possible,
// so callers should *not* refuse outright; they should sanitize / log.
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|messages?|rules?)\b/i,
  /\bdisregard\s+(previous|prior|above|all)\b/i,
  /\bforget\s+(previous|prior|above|everything)\b/i,
  /\b(reveal|show|print|leak|repeat)\s+(your|the)\s+(system\s+)?prompt\b/i,
  /\bact\s+as\s+(a\s+)?(different|another|new)\s+(model|assistant|ai|chatbot)\b/i,
  /\byou\s+are\s+now\s+(a\s+)?(different|new)\b/i,
  /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>|<\|assistant\|>/i,
];

export function looksLikeInjection(text: string): boolean {
  if (!text) return false;
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

// Redact obvious PII from text before writing it to logs (best-effort).
export function redactForLogs(text: string): string {
  if (!text) return text;
  return text
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
    .replace(/\b(?:\+?\d{1,3}[\s-]?)?\(?\d{3,5}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, "<phone>")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "<card>");
}
