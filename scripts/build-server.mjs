// Compile server.ts (+ its worker/lib graph) to dist/server.cjs.
//
// Production currently runs `tsx server.ts`, which means a TypeScript compiler is
// resident for the life of the process purely to re-derive output that never
// changes between restarts. Railway bills this service ~88% for memory, so that
// residency is the single largest thing we can remove without touching
// architecture. `majestic-escape-chat-server` already runs `node dist/index.js`.
//
// ── Why CommonJS output, and not ESM ────────────────────────────────
//
// ESM was tried first, on the reasoning that `server.ts` is written as ESM and
// `tsx` runs it as ESM, so ESM output would preserve the current dependency
// interop most faithfully. That reasoning was wrong, and it failed twice at
// boot — loudly, which is the one good thing about it:
//
//   1. SyntaxError: Named export 'loadEnvConfig' not found. The requested
//      module '@next/env' is a CommonJS module...
//
//      `@next/env` is CJS and Node's static analysis cannot see `loadEnvConfig`
//      as a named export. `tsx` never hits this because its loader resolves the
//      import through `require` interop.
//
//   2. ReferenceError: __dirname is not defined in ES module scope
//
//      ...after bundling `@next/env` to work around (1). It is an ncc-built
//      bundle that references `__dirname`.
//
// Both are the same underlying fact: our dependencies are CommonJS, and ESM
// output requires shims to emulate what CJS gives natively. CJS output makes
// both problems disappear rather than papering over them — `require("@next/env")
// .loadEnvConfig` needs no static export detection, and `__dirname` genuinely
// exists. The extension is `.cjs` so Node's module resolution does not depend on
// the absence of `"type": "module"` in package.json.
//
// ── The other decisions ─────────────────────────────────────────────
//
// `packages: "external"` — only our own source is bundled; every bare import
// stays a runtime require. Bundling node_modules would inline Next.js and the
// Mongo driver, which is pointless (already compiled) and risky (both do runtime
// resolution that static bundling breaks). esbuild still resolves this repo's
// `@/` tsconfig path alias, which is not a package.
//
// Bundling our own `src/**` is safe because no module in that graph reads
// `process.env` at module scope — every read is inside a function body. That was
// verified before writing this, not assumed. It matters because `server.ts:3`
// calls `loadEnvConfig` and the file's own comment claims the worker imports are
// deferred "because they read process.env at module-load time". They don't, any
// more. If that ever stops being true, this bundle could evaluate a module
// before the env is loaded.
//
// `sourcemap: true` emits `dist/server.cjs.map`, but note what that does and
// does not buy: Node ignores source maps unless started with
// `--enable-source-maps`, which we deliberately do NOT pass. Enabling it makes
// V8 load and retain map data whenever a stack is formatted, and this whole
// change exists to reduce resident memory. The map is emitted so it is there
// when someone wants it (`node --enable-source-maps dist/server.cjs` locally,
// or temporarily in prod while chasing a specific trace).
//
// Day-to-day readability comes from `keepNames: true` instead: function names
// survive into the bundle, so a production trace still reads
// `at handleChange (...)` rather than `at t (...)`. That covers the diagnostic
// need at zero runtime cost.

import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

const result = await build({
  entryPoints: ["server.ts"],
  outfile: "dist/server.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  // Match the Node major Railway runs, so esbuild does not down-level syntax the
  // runtime supports natively.
  target: "node22",
  packages: "external",
  sourcemap: true,
  // Keep names intact: the change-stream and support-socket logs identify
  // handlers by function name, and minified traces would make an incident harder
  // to read for no memory benefit (this is disk, not RSS).
  minify: false,
  keepNames: true,
  logLevel: "info",
  metafile: true,
});

const out = result.metafile.outputs["dist/server.cjs"];
console.log(
  `\n[build-server] dist/server.cjs — ${(out.bytes / 1024).toFixed(1)} kB from ` +
    `${Object.keys(result.metafile.inputs).length} source files`
);
