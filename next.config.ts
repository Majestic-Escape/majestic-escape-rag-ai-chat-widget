import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "majestic-escape-host-properties.blr1.digitaloceanspaces.com" },
    ],
  },
  // Don't fail builds on lint warnings during initial scaffolding
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        // The standalone embed bundle (built by Vite into public/embed/widget.js)
        // must be loadable cross-origin from user.website (and any other approved
        // host). Allow all origins on the asset itself; abuse is constrained
        // upstream by the API's ALLOWED_ORIGINS check.
        source: "/embed/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          {
            key: "Cache-Control",
            // Short TTL so widget-repo deploys propagate quickly, with a long
            // SWR window so users still get the cached copy instantly.
            value: "public, max-age=300, stale-while-revalidate=86400",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
