import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Development only: lets the dev server be opened through a public HTTPS tunnel (pnpm --filter @kaada/api dev:tunnels), which
  // Telegram's secure buttons need. It has no effect on a production build.
  allowedDevOrigins: ["*.trycloudflare.com"],
  // The browser talks to the API through this same origin, so the page that registers a passkey and the origin the server
  // verifies are one and the same. /api/* is served by app/api/[...path]/route.ts, which proxies to API_URL at request time
  // (not at build time) and logs every failure with its exact cause.
  headers() {
    return [
      {
        // The recovery start page (no token in its path) is covered too: it holds a session token in memory.
        source: "/recovery",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // A setup link carries a bearer token in its path: never cache it, never send it as a referrer,
        // never let another site frame it.
        source: "/:area(setup|authorize|root-action|security|recovery)/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
