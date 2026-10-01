// Backend URL resolution — three sources, in priority order:
// 1. window.MAJESTIC_CHAT_BACKEND (explicit page override)
// 2. VITE_BACKEND_URL build-time injection
// 3. Origin of the script tag that loaded this bundle (auto-derived)
// 4. Current page origin (final fallback for same-origin dev)
declare global {
  interface Window {
    MAJESTIC_CHAT_BACKEND?: string;
    __majesticChatScriptSrc?: string;
  }
}

export function getBackendUrl(): string {
  if (typeof window === "undefined") return "";
  if (window.MAJESTIC_CHAT_BACKEND) return window.MAJESTIC_CHAT_BACKEND.replace(/\/$/, "");
  const buildTime = (import.meta as { env?: { VITE_BACKEND_URL?: string } }).env?.VITE_BACKEND_URL;
  if (buildTime) return buildTime.replace(/\/$/, "");
  const scriptSrc = window.__majesticChatScriptSrc;
  if (scriptSrc) {
    try {
      return new URL(scriptSrc).origin;
    } catch {
      /* fall through */
    }
  }
  return window.location.origin;
}

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("token") || localStorage.getItem("authToken");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string" && parsed.length > 0) return parsed;
  } catch {
    /* not JSON — treat as raw token */
  }
  return raw;
}

const GUEST_ID_KEY = "meSupportGuestId";
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export function readGuestCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)meSupportGuestId=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function writeGuestCookie(id: string): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${GUEST_ID_KEY}=${encodeURIComponent(id)}; Max-Age=${GUEST_COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
}

// crypto.randomUUID() is only available on secure contexts (HTTPS or
// localhost). Fall back to crypto.getRandomValues — available everywhere —
// and format as RFC4122 v4 ourselves so guest IDs still look canonical.
export function safeUuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : null;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function getOrCreateGuestId(): string | null {
  if (typeof window === "undefined") return null;
  let id = localStorage.getItem(GUEST_ID_KEY);
  const cookieId = readGuestCookie();
  if (!id && cookieId) {
    id = cookieId;
    localStorage.setItem(GUEST_ID_KEY, id);
  }
  if (!id) {
    id = `g_${safeUuid()}`;
    localStorage.setItem(GUEST_ID_KEY, id);
  }
  if (!cookieId || cookieId !== id) {
    writeGuestCookie(id);
  }
  return id;
}

// Reactive pathname hook — used to decide whether the widget should render on
// the current route. Listens for both native back/forward and SPA navigation
// (Next.js router.push uses history.pushState under the hood). Restores the
// original history methods on unmount so we never leave the host page in a
// patched state.
import { useEffect, useState } from "react";

let pushPatchCount = 0;
let originalPushState: typeof history.pushState | null = null;
let originalReplaceState: typeof history.replaceState | null = null;
const PATH_CHANGE_EVENT = "majestic-chat:locationchange";

function patchHistory(): void {
  if (pushPatchCount === 0) {
    originalPushState = history.pushState;
    originalReplaceState = history.replaceState;
    history.pushState = function (...args: Parameters<typeof history.pushState>) {
      originalPushState!.apply(this, args);
      window.dispatchEvent(new Event(PATH_CHANGE_EVENT));
    };
    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
      originalReplaceState!.apply(this, args);
      window.dispatchEvent(new Event(PATH_CHANGE_EVENT));
    };
  }
  pushPatchCount++;
}

function unpatchHistory(): void {
  pushPatchCount--;
  if (pushPatchCount === 0) {
    if (originalPushState) history.pushState = originalPushState;
    if (originalReplaceState) history.replaceState = originalReplaceState;
    originalPushState = null;
    originalReplaceState = null;
  }
}

export function useCurrentPathname(): string {
  const [path, setPath] = useState<string>(() =>
    typeof window === "undefined" ? "/" : window.location.pathname
  );
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    patchHistory();
    window.addEventListener("popstate", update);
    window.addEventListener(PATH_CHANGE_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(PATH_CHANGE_EVENT, update);
      unpatchHistory();
    };
  }, []);
  return path;
}

// The host page has a modal up: a bottom sheet, a dialog, a lightbox. Read from
// what every such modal does to the page rather than from any one site's
// markup, so a sheet added later is covered without touching this file. It
// locks the page's scroll:
//   - body pinned with position:fixed, or overflow:hidden on body or html
//     (user.website's own sheets, the photo lightbox, the menu);
//   - or react-remove-scroll's data-scroll-locked on body (Radix dialogs and
//     sheets, vaul drawers).
// A host modal that cannot lock scroll sets data-majestic-chat-hide-launcher on
// <html> instead.
//
// Everything here is an attribute of <html> or <body>, which is the point: it
// can be watched for the price of two observers. `aria-modal` is NOT used,
// although it reads naturally: a sheet unlocks the page and then unmounts a
// beat later, deep in the React tree, and that removal is invisible without
// observing the whole subtree of the host app — so the launcher stayed hidden
// after the sheet closed.
//
// Only overflow-y is read: user.website sets overflow-x:hidden on body and
// html all the time, which computes overflow-y to auto, not hidden.
const LOCKED = new Set(["hidden", "clip"]);
const HIDE_LAUNCHER_ATTR = "data-majestic-chat-hide-launcher";

function hostModalOpen(): boolean {
  const body = document.body;
  const root = document.documentElement;
  if (!body) return false;
  if (root.hasAttribute(HIDE_LAUNCHER_ATTR) || body.hasAttribute("data-scroll-locked")) return true;
  const bodyStyle = getComputedStyle(body);
  return (
    bodyStyle.position === "fixed" ||
    LOCKED.has(bodyStyle.overflowY) ||
    LOCKED.has(getComputedStyle(root).overflowY)
  );
}

// `paused` while the widget itself is open: its own scroll lock looks exactly
// like a host modal, and the launcher is out of the way then anyway. It
// re-reads when that ends, after the lock has been released.
//
// Cheap on purpose: no subtree observer on a React app. It watches only the
// attributes a scroll lock flips on <html> and <body>, and coalesces a burst of
// changes into one read per frame.
export function useHostModalOpen(paused: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (paused || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      setOpen(hostModalOpen());
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    sync();
    const watched = ["style", "class", "data-scroll-locked", HIDE_LAUNCHER_ATTR];
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: watched });
    observer.observe(document.body, { attributes: true, attributeFilter: watched });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [paused]);
  return open;
}
