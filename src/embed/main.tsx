// Entry for the standalone embed bundle. Built by Vite (see vite.embed.config.ts)
// into a single self-contained .js file that is loaded onto the host page via
// <script src=".../widget.js" defer>. The script:
//
//   1. Captures its own URL so `getBackendUrl()` can derive the API origin.
//   2. Registers a `<majestic-chat-widget>` custom element. The element creates
//      an open Shadow DOM, injects the Tailwind-compiled CSS, and mounts a
//      React tree containing <ChatWidget />.
//   3. Auto-creates one such element on `<body>` if the host page doesn't
//      explicitly include one — keeps integration to a single <script> tag.
//
// Tailwind classes that the widget uses live inside the Shadow DOM, so they
// can never collide with the host page's own styles. The host page can never
// accidentally break the widget either.
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { ChatWidget } from "./ChatWidget";

// Inlined by vite-plugin-css-injected-by-js as a string at build time.
// We don't actually use the auto-injection (it would attach styles to the host
// document); instead we read the same content via `?inline` so we can scope it
// inside the Shadow DOM ourselves.
import styles from "./styles.css?inline";

// Capture the script tag's URL before any other code runs, so getBackendUrl()
// can fall back to it. document.currentScript only exists during initial
// synchronous evaluation — once the bundle's IIFE returns, it's null.
(() => {
  if (typeof window === "undefined") return;
  const currentScript = document.currentScript as HTMLScriptElement | null;
  if (currentScript?.src) {
    window.__majesticChatScriptSrc = currentScript.src;
  }
})();

const TAG_NAME = "majestic-chat-widget";

class MajesticChatWidgetElement extends HTMLElement {
  private root: Root | null = null;
  private mountNode: HTMLDivElement | null = null;

  connectedCallback(): void {
    if (this.shadowRoot) return; // already mounted (custom-element re-attach)

    const shadow = this.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = styles;
    shadow.appendChild(styleEl);

    const mount = document.createElement("div");
    mount.id = "majestic-chat-mount";
    // Tailwind utilities expect a containing element. Give it a baseline so
    // every descendent inherits the right font + box-sizing.
    mount.style.fontFamily = "var(--font-poppins)";
    shadow.appendChild(mount);
    this.mountNode = mount;

    this.root = createRoot(mount);
    this.root.render(<ChatWidget />);
  }

  disconnectedCallback(): void {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    this.mountNode = null;
  }
}

function register(): void {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(TAG_NAME)) return;
  customElements.define(TAG_NAME, MajesticChatWidgetElement);
}

function autoMount(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(TAG_NAME)) return; // host page mounted one explicitly
  const el = document.createElement(TAG_NAME);
  document.body.appendChild(el);
}

register();

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoMount, { once: true });
  } else {
    autoMount();
  }
}
