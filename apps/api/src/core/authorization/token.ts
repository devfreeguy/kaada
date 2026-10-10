import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes as base64url: 256 bits, so a fast hash is the right way to store it. */
export const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
