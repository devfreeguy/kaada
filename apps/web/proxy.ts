import { NextResponse, type NextRequest } from "next/server";

const marketingHosts = new Set(["kaada.xyz", "www.kaada.xyz", "localhost"]);
const applicationArea = /^\/(setup|authorize|root-action|security|recovery)(?:\/|$)/;

export function proxy(request: NextRequest) {
  // Use the request host, never an arbitrary forwarded-host header.
  const host = (request.headers.get("host") ?? "").split(":")[0]?.toLowerCase();
  const pathname = request.nextUrl.pathname;
  // Internal marketing route must only be reachable through the hostname rewrite.
  if (pathname === "/marketing" || pathname.startsWith("/marketing/")) {
    return new NextResponse(null, { status: 404 });
  }
  if (!host || !marketingHosts.has(host)) return NextResponse.next();
  if (applicationArea.test(pathname) && host !== "localhost") {
    const target = request.nextUrl.clone();
    target.protocol = "https:";
    target.host = "app.kaada.xyz";
    target.port = "";
    const response = NextResponse.redirect(target, 307);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
  if (pathname === "/") {
    const target = request.nextUrl.clone();
    target.pathname = "/marketing";
    return NextResponse.rewrite(target);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/marketing/:path*",
    "/setup/:path*",
    "/authorize/:path*",
    "/root-action/:path*",
    "/security/:path*",
    "/recovery/:path*",
  ],
};
