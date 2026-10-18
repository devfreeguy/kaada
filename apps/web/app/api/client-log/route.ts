import type { NextRequest } from "next/server";

import { logServer, maskPath } from "../../lib/server-log";

/**
 * Where the browser reports what went wrong on a person's device (a failed request, a passkey the browser refused, a crashed
 * page), so it shows up in the same log as the server's. Bounded and rate limited, and it stores and echoes nothing: fields
 * are length-capped, paths are masked, and the log line is the only effect.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 4096;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const seen = new Map<string, { count: number; resetAt: number }>();

function allowed(key: string): boolean {
  const now = Date.now();
  const entry = seen.get(key);
  if (!entry || entry.resetAt <= now) {
    if (seen.size > 5000) seen.clear();
    seen.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_PER_WINDOW;
}

const text = (value: unknown, max = 300): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

export async function POST(request: NextRequest): Promise<Response> {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!allowed(ip)) return new Response(null, { status: 429 });

  let raw = "";
  try {
    raw = (await request.text()).slice(0, MAX_BODY);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const level = body["level"] === "warn" ? "warn" : "error";
    logServer(level, `client.${text(body["event"], 80) ?? "unknown"}`, {
      source: "browser",
      page: maskPath(text(body["page"], 200) ?? ""),
      url: maskPath(text(body["url"], 200) ?? ""),
      method: text(body["method"], 10),
      status: typeof body["status"] === "number" ? body["status"] : undefined,
      code: text(body["code"], 80),
      requestId: text(body["requestId"], 64),
      errorName: text(body["errorName"], 80),
      errorMessage: text(body["errorMessage"]),
      userAgent: text(request.headers.get("user-agent"), 200),
      secureContext: typeof body["secureContext"] === "boolean" ? body["secureContext"] : undefined,
      origin: text(body["origin"], 200),
      online: typeof body["online"] === "boolean" ? body["online"] : undefined,
    });
  } catch {
    logServer("warn", "client.log_rejected", {
      reason: "the report was not valid JSON",
      length: raw.length,
    });
    return new Response(null, { status: 400 });
  }
  return new Response(null, { status: 204 });
}
