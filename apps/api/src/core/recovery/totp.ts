import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * RFC 6238 time-based one-time passwords, in the exact profile every authenticator app implements by default: HMAC-SHA-1,
 * 6 digits, 30-second steps. (SHA-1 is kept deliberately: it is what Google Authenticator, Microsoft Authenticator, Authy and
 * 1Password all use unless told otherwise, and an HMAC-SHA-1 TOTP is not weakened by SHA-1's collision weakness.)
 * Nothing here touches storage, time or the network: the callers pass the clock in.
 */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** Accept the previous, current and next step only: the clock-skew window. */
export const TOTP_WINDOW_STEPS = 1;
/** 160 bits, the RFC 4226 recommended secret length. */
export const TOTP_SECRET_BYTES = 20;

export const TOTP_CODE_PATTERN = /^[0-9]{6}$/;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret from the OS CSPRNG, base32 (the form authenticator apps and `otpauth://` URIs use). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** The 30-second time step a moment falls in. */
export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);

/** RFC 4226 HOTP over a counter. */
function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

/** The code an authenticator shows for `step`. */
export function totpAtStep(base32Secret: string, step: number): string {
  return hotp(base32Decode(base32Secret), step);
}

/**
 * The time step `code` is valid for, within ±TOTP_WINDOW_STEPS of `nowMs`, or null. Every candidate step is compared in
 * constant time and all of them are always evaluated, so timing does not reveal which step (if any) matched.
 */
export function matchTotp(base32Secret: string, code: string, nowMs: number): number | null {
  if (!TOTP_CODE_PATTERN.test(code)) return null;
  const secret = base32Decode(base32Secret);
  const given = Buffer.from(code, "utf8");
  const current = stepAt(nowMs);
  let matched: number | null = null;
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta++) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step), "utf8");
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = step;
  }
  return matched;
}

/** The standard `otpauth://totp` provisioning URI (what a QR code carries). */
export function otpauthUri(input: { secret: string; issuer: string; account: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
