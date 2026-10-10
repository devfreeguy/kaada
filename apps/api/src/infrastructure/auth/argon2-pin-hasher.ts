import { hash, verify } from "@node-rs/argon2";
import type { Algorithm } from "@node-rs/argon2";

import type { PinHasher } from "../../core/authorization/ports.js";

/**
 * Argon2id through @node-rs/argon2 (a Rust implementation of the reference algorithm run on a worker
 * thread, so hashing never blocks the event loop). Kaada implements no hashing of its own.
 *
 * Parameters: 64 MiB of memory, 3 passes, 1 lane (above the OWASP minimum of 19 MiB / 2 passes), which
 * costs tens of milliseconds per check on a server: invisible to a person, and an online attacker is
 * limited by the lockout, not by this cost. Verification is constant-time inside the library.
 *
 * A PIN has only 10,000 values, so an offline attacker with a leaked database could try them all
 * whatever the cost. The optional `pepper` (a server-side secret, never stored in the database) is
 * mixed in as the Argon2 secret input, which makes a database leak alone useless. It must stay
 * constant: changing it makes existing PIN hashes unverifiable (those users re-create their PIN).
 */
/** Argon2id. The library exposes it as an ambient const enum, which a bundler-safe build cannot import. */
const ARGON2ID = 2 as Algorithm;

export const PIN_ARGON2_PARAMS = { memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

export interface Argon2PinHasherOptions {
  pepper?: string;
  /** Test-only cost reduction. Production uses PIN_ARGON2_PARAMS. */
  params?: { memoryCost: number; timeCost: number; parallelism: number };
}

export class Argon2PinHasher implements PinHasher {
  private readonly secret: Buffer | undefined;
  private readonly params: { memoryCost: number; timeCost: number; parallelism: number };

  constructor(options: Argon2PinHasherOptions = {}) {
    this.secret = options.pepper !== undefined ? Buffer.from(options.pepper, "utf8") : undefined;
    this.params = options.params ?? PIN_ARGON2_PARAMS;
  }

  hash(pin: string): Promise<string> {
    return hash(pin, {
      algorithm: ARGON2ID,
      ...this.params,
      ...(this.secret && { secret: this.secret }),
    });
  }

  async verify(storedHash: string, pin: string): Promise<boolean> {
    try {
      return await verify(storedHash, pin, this.secret && { secret: this.secret });
    } catch {
      // A malformed stored hash is a failed check, never a thrown secret.
      return false;
    }
  }
}
