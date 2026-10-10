import type { NextConfig } from "next";

// The browser talks to the API through this same origin, so the page that registers a passkey and
// the origin the server verifies are one and the same, and no CORS exception is needed.
const apiUrl = (process.env["API_URL"] ?? "http://localhost:4000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  headers() {
    return [
      {
        // A setup link carries a bearer token in its path: never cache it, never send it as a referrer,
        // never let another site frame it.
        source: "/:area(setup|authorize)/:path*",
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
