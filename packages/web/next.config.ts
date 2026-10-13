import type { NextConfig } from "next";
import { contentSecurityPolicy } from "./src/lib/x-media-policy.ts";

// Next reports anonymous usage figures about its own commands to its maker
// unless it is told not to. This app asks no other host for anything, so it
// is told not to: here, because a build reads this file before it reads the
// setting, and whoever runs a build then needs no variable of their own.
process.env.NEXT_TELEMETRY_DISABLED = "1";

const nextConfig: NextConfig = {
  // The extension's protocol module is TypeScript source with no build of its
  // own, so Next compiles it with the app. Core is deliberately not listed:
  // see src/server/core.ts.
  transpilePackages: ["@curio/extension"],
  // Where the build goes. The end-to-end test names a directory of its own,
  // so that it never rebuilds over the one a running app is serving from.
  distDir: process.env.CURIO_NEXT_DIR || ".next",
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
          // What a page may load, and from where: this app, and X's two
          // media hosts for media the owner asks to see. Anything else is
          // refused by the browser before it asks.
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
          // A post's links lead all over the web, X included. The browser
          // is not to look any of them up until one is clicked.
          { key: "X-DNS-Prefetch-Control", value: "off" },
        ],
      },
    ];
  },
};

export default nextConfig;
