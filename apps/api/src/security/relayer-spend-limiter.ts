import { HttpException, HttpStatus } from "@nestjs/common";
import { createLogger } from "@kaada/logger";

import { RateLimiter } from "../core/authorization/rate-limiter.js";
import type { RateLimit } from "../core/authorization/rate-limiter.js";

export const RELAYER_SPEND_LIMITER = Symbol("RELAYER_SPEND_LIMITER");

/** The endpoints that make the recovery relayer pay gas. Each kind is counted on its own. */
export type RelayerSpendKind = "arming" | "device-key" | "cancel";

export interface RelayerSpendLimits {
  readonly perUserPerHour: number;
  readonly perIpPerHour: number;
}

type MakeLimit = (name: string, limit: number, windowMs: number) => RateLimit;

const HOUR_MS = 3_600_000;
const log = createLogger({ level: process.env["LOG_LEVEL"] ?? "info" });

/**
 * A cap on how often one person, and one address, can make the relayer spend gas: arming a Recovery Code (which can top a wallet up),
 * registering a device key (which deploys a validator) and cancelling a recovery. Each is real money, so none may be repeated freely.
 * The address is counted first (before anything is looked up), the person once the request's token has been checked.
 */
export class RelayerSpendLimiter {
  private readonly perUser = new Map<RelayerSpendKind, RateLimit>();
  private readonly perIp = new Map<RelayerSpendKind, RateLimit>();

  constructor(
    limits: RelayerSpendLimits,
    make: MakeLimit = (_name, limit, windowMs) => new RateLimiter(limit, windowMs),
  ) {
    for (const kind of ["arming", "device-key", "cancel"] as const) {
      this.perUser.set(kind, make(`relayer-spend:${kind}:user`, limits.perUserPerHour, HOUR_MS));
      this.perIp.set(kind, make(`relayer-spend:${kind}:ip`, limits.perIpPerHour, HOUR_MS));
    }
  }

  /** Counts one use by this address; throws 429 when the address has used up its hour. */
  async checkIp(kind: RelayerSpendKind, ip: string): Promise<void> {
    if (await this.bucket(this.perIp, kind).allow(ip || "unknown")) return;
    log.warn(
      { event: "relayer_spend.limited", kind, scope: "ip", ip },
      `relayer-spend limit reached for ${kind} by address ${ip}`,
    );
    throw tooMany();
  }

  /** Counts one use by this person (any stable id); throws 429 when they have used up their hour. */
  async checkUser(kind: RelayerSpendKind, userId: string): Promise<void> {
    if (await this.bucket(this.perUser, kind).allow(userId)) return;
    log.warn(
      { event: "relayer_spend.limited", kind, scope: "user", userId },
      `relayer-spend limit reached for ${kind} by user ${userId}`,
    );
    throw tooMany();
  }

  private bucket(map: Map<RelayerSpendKind, RateLimit>, kind: RelayerSpendKind): RateLimit {
    const found = map.get(kind);
    if (!found) throw new Error(`no relayer-spend limit for ${kind}`);
    return found;
  }
}

const tooMany = (): HttpException =>
  new HttpException(
    "too many requests of this kind, try again later",
    HttpStatus.TOO_MANY_REQUESTS,
  );
