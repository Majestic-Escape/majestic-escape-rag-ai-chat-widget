// Standalone client-side bundle for the embed widget.
//
// Output: public/embed/widget.js — Next.js serves /public at the root, so the
// bundle is reachable at GET /embed/widget.js once the widget service is up.
//
// The bundle is a single self-contained IIFE that includes React, react-dom,
// lucide icons, and socket.io-client. The Tailwind-compiled CSS is imported
// as a raw string (?inline) and injected into a Shadow DOM at mount time —
// see src/embed/main.tsx. We deliberately do NOT use vite-plugin-css-injected-by-js
// because that auto-injects styles into the host document; we want them
// scoped inside the Shadow DOM instead.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  define: {
    // React 19 expects this — keeps prod runtime smaller.
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    target: "es2020",
    outDir: path.resolve(__dirname, "public/embed"),
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: "esbuild",
    sourcemap: false,
    lib: {
      entry: path.resolve(__dirname, "src/embed/main.tsx"),
      name: "MajesticChatWidget",
      formats: ["iife"],
      fileName: () => "widget.js",
    },
    rollupOptions: {
      output: {
        // Keep everything in one file so the host page only needs one <script>.
        inlineDynamicImports: true,
      },
    },
  },
});
