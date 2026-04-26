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
};

export default nextConfig;
