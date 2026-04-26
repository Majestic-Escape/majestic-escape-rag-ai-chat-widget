// This service is backend-only. The user-facing chat widget lives in `user.website`,
// and the admin support-reply UI is intended to live in `admin.site`.
//
// Public surface of this Railway service:
//   POST /api/chat                 streaming RAG (Gemini → Groq → xAI)
//   GET  /api/health               liveness + db + change-stream status
//   POST /api/admin/embed-all      bulk re-index (admin JWT)
//   POST /api/admin/embed/:id      single re-embed (admin JWT)
//   WS   /support  (Socket.IO)     user↔admin support chat
export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8 font-poppins">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold text-primaryGreen mb-2">
          Majestic Escape — Chatbot Backend
        </h1>
        <p className="text-stone text-sm">
          This is a backend-only service. The user-facing chat widget lives on
          majesticescape.in. There is no UI here.
        </p>
        <p className="text-xs text-solidGray mt-4">
          Health: <a className="underline" href="/api/health">/api/health</a>
        </p>
      </div>
    </main>
  );
}
