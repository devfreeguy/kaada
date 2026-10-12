import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/** A 6-digit email code from a cryptographically secure source. */
export function newEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export const EMAIL_CODE_PATTERN = /^[0-9]{6}$/;

/**
 * HMAC-SHA-256 of the code under a server secret, bound to the attempt, so a leaked table cannot be brute-forced offline
 * without the secret and a code cannot be moved between attempts.
 */
export function hashEmailCode(secret: Buffer, attemptId: string, code: string): string {
  return createHmac("sha256", secret)
    .update(`kaada.recovery.email:${attemptId}:${code}`)
    .digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Lower-cases and trims an email; null if it is not plausibly one (so junk never reaches a lookup). */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const email = input.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
