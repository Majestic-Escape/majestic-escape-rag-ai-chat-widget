// Load .env.local / .env before any other imports so process.env is populated.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { createServer } from "http";
import next from "next";
import { Server as IOServer } from "socket.io";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3001;

async function main() {
  // Lazy-import modules that read process.env at module-load time, AFTER env is loaded.
  const { startChangeStreamWorker } = await import("./src/workers/changeStream");
  const { runCatchUpSync } = await import("./src/workers/catchUpSync");
  const { mountSupportNamespace } = await import("./src/lib/supportSocket");

  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  const httpServer = createServer((req, res) => handle(req, res));

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // CORS policy mirrors src/middleware.ts so REST + WebSocket gates behave
  // identically. In dev (NODE_ENV !== production) any origin is allowed so
  // LAN-IP access from a phone (http://192.168.x.x:3000) just works without
  // having to enumerate every dev's machine IP in ALLOWED_ORIGINS. In prod
  // we lock down to the explicit allow-list (or accept all if unset, which
  // matches the historical fallback).
  const corsOriginCheck = (
    origin: string | undefined,
    cb: (err: Error | null, allow?: boolean | string | string[]) => void
  ) => {
    if (!origin) return cb(null, true);
    if (process.env.NODE_ENV !== "production") return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true);
    cb(null, allowedOrigins.includes(origin));
  };

  const io = new IOServer(httpServer, {
    cors: {
      origin: corsOriginCheck,
      credentials: true,
    },
  });
  mountSupportNamespace(io);

  // Background workers — fire-and-forget. They self-heal on errors.
  runCatchUpSync().catch((err) =>
    console.error("[boot] catchUpSync failed:", err)
  );
  startChangeStreamWorker().catch((err) =>
    console.error("[boot] changeStream crashed:", err)
  );

  httpServer.listen(port, () => {
    console.log(`[boot] ready on http://localhost:${port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[boot] received ${signal}, shutting down`);
    io.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[boot] fatal", err);
  process.exit(1);
});
