import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The extension's protocol module is TypeScript source with no build of its
  // own, so Next compiles it with the app. Core is deliberately not listed:
  // see src/server/core.ts.
  transpilePackages: ["@x-bookmarks/extension"],
  // Where the build goes. The end-to-end test names a directory of its own,
  // so that it never rebuilds over the one a running app is serving from.
  distDir: process.env.X_BOOKMARKS_NEXT_DIR || ".next",
  poweredByHeader: false,
  async headers() {
    return [
      {
        // No other site may frame these pages or load them as a resource.
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
