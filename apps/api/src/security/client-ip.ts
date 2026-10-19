import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";

/**
 * The address a request really comes from, for per-address limits.
 *
 * Browsers reach the API through the web app's proxy, so the socket address is always the proxy's (and Caddy's): every person would
 * share one address and one limit. The proxy therefore passes the visitor's address in `x-kaada-client-ip`, proven by a secret only it
 * and the API know (`PROXY_SHARED_SECRET` on both). Without the secret, or when the proof is wrong, the header is ignored and the
 * socket address is used, so nobody calling the API directly can pick the address they are counted under.
 */
export const CLIENT_IP_HEADER = "x-kaada-client-ip";
export const PROXY_AUTH_HEADER = "x-kaada-proxy-auth";

type Headers = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

function sameSecret(presented: string, secret: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function clientIpOf(
  request: { ip?: string | undefined; headers: Headers },
  secret: string | undefined,
): string {
  const socket = request.ip ?? "unknown";
  if (!secret) return socket;
  const presented = single(request.headers[PROXY_AUTH_HEADER]);
  const claimed = single(request.headers[CLIENT_IP_HEADER])?.trim();
  if (!presented || !claimed || !sameSecret(presented, secret)) return socket;
  return isIP(claimed) !== 0 ? claimed : socket;
}

/** `@ClientIp() ip: string` in a controller method. */
export const ClientIp = createParamDecorator((_data: unknown, context: ExecutionContext): string =>
  clientIpOf(
    context.switchToHttp().getRequest<{ ip?: string; headers: Headers }>(),
    process.env["PROXY_SHARED_SECRET"]?.trim() || undefined,
  ),
);
