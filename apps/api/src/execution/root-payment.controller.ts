import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Ip,
  Optional,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { isKaadaError } from "@kaada/domain";
import { z } from "zod";

import { RateLimiter } from "../core/authorization/rate-limiter.js";
import type { RateLimit } from "../core/authorization/rate-limiter.js";
import { hashOpaqueToken } from "../core/authorization/token.js";
import type { RootPaymentService } from "../core/execution/root-payment-service.js";
import { RATE_LIMIT_FACTORY } from "../rate-limit/rate-limit.tokens.js";
import type { RateLimitFactory } from "../rate-limit/rate-limit.module.js";
import { parseRootProof } from "../roots/root-proof.schema.js";
import { ROOT_PAYMENT_SERVICE } from "./execution.tokens.js";

const confirmBody = z.strictObject({
  operation: z.string().min(1).max(32_768),
  proof: z.unknown(),
  pin: z.string().max(16).optional(),
});

function bearer(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match?.[1]) throw new UnauthorizedException("an authorization token is required");
  return match[1];
}

/**
 * Confirming a direct payment with the wallet's own passkey (or device key plus PIN) instead of a PIN alone. The identity is the same
 * opaque authorization link as the PIN page, and the browser sends nothing but a sealed blob the server made and the root's proof:
 * the recipient, amount and calldata come from storage. See RootPaymentService.
 */
@Controller({ path: "authorization/root", version: "1" })
export class RootPaymentController {
  private readonly perToken: RateLimit;
  private readonly perAddress: RateLimit;

  constructor(
    @Inject(ROOT_PAYMENT_SERVICE) private readonly service: RootPaymentService | null,
    @Optional() @Inject(RATE_LIMIT_FACTORY) limits?: RateLimitFactory,
  ) {
    const make = limits ?? ((_name, limit, windowMs) => new RateLimiter(limit, windowMs));
    this.perToken = make("root-payment:token", 12, 60_000);
    this.perAddress = make("root-payment:address", 30, 60_000);
  }

  private active(): RootPaymentService {
    if (!this.service) throw new ServiceUnavailableException("this confirmation is not enabled");
    return this.service;
  }

  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        isKaadaError(error, "AUTHORIZATION_SESSION_INVALID") ||
        isKaadaError(error, "CREDENTIAL_REJECTED")
      ) {
        throw new UnauthorizedException(
          "this link is not valid, has expired, or was already used",
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async limit(token: string, ip: string): Promise<void> {
    if (
      !(await this.perToken.allow(hashOpaqueToken(token))) ||
      !(await this.perAddress.allow(ip || "unknown"))
    ) {
      throw new HttpException("too many attempts, wait a moment", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** How this payment is confirmed: with the wallet's root ("ROOT"), or the PIN. A service that is off answers "PIN". */
  @Get("method")
  @Header("Cache-Control", "no-store")
  async method(@Headers("authorization") authorization?: string) {
    const service = this.service;
    if (!service) return { method: "PIN" };
    return this.guarded(() => service.method(bearer(authorization)));
  }

  /** The prompt to show (a passkey request or a device-key payload) and the sealed operation to send back with the answer. */
  @Post("options")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async options(@Headers("authorization") authorization: string | undefined, @Ip() ip: string) {
    const token = bearer(authorization);
    await this.limit(token, ip);
    const begun = await this.guarded(() => this.active().begin(token));
    if (begun.status === "READY") {
      return { challenge: begun.challenge, operation: begun.operation, rootType: begun.rootType };
    }
    throw new ConflictException({ code: begun.status, message: shortfallText(begun.status) });
  }

  @Post("confirm")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async confirm(
    @Body() body: unknown,
    @Headers("authorization") authorization: string | undefined,
    @Ip() ip: string,
  ) {
    const token = bearer(authorization);
    await this.limit(token, ip);
    const parsed = confirmBody.safeParse(body);
    const proof = parsed.success ? parseRootProof(parsed.data.proof) : null;
    if (!parsed.success || !proof) throw new BadRequestException("invalid request");

    const result = await this.guarded(() =>
      this.active().confirm(token, {
        operation: parsed.data.operation,
        proof,
        ...(parsed.data.pin !== undefined && { pin: parsed.data.pin }),
      }),
    );
    switch (result.status) {
      case "SENT":
        return { status: "SENT", action: "PAYMENT_READY" };
      case "PIN_REQUIRED":
        throw new BadRequestException({ code: "PIN_REQUIRED", message: "Enter your PIN." });
      case "INVALID_PIN":
        throw new HttpException(
          {
            code: "INVALID_PIN",
            message: "That PIN is incorrect.",
            attemptsRemaining: result.attemptsRemaining,
            ...(result.lockedUntil && { lockedUntil: result.lockedUntil.toISOString() }),
          },
          HttpStatus.UNAUTHORIZED,
        );
      case "LOCKED":
        throw new HttpException(
          {
            code: "PIN_LOCKED",
            message: "Too many wrong attempts. Try again later.",
            lockedUntil: result.lockedUntil.toISOString(),
          },
          HttpStatus.LOCKED,
        );
      case "PIN_NOT_SET":
        throw new ConflictException({ code: "PIN_NOT_SET", message: "Create your PIN first." });
      case "PIN_RESET_REQUIRED":
        throw new ConflictException({
          code: "PIN_RESET_REQUIRED",
          message: "Your PIN must be reset through account recovery.",
        });
      case "INVALID_FORMAT":
        throw new BadRequestException({ code: "INVALID_FORMAT", message: "Enter six digits." });
      case "NOT_AVAILABLE":
      case "INSUFFICIENT_BALANCE":
      case "GAS_FUNDING_REQUIRED":
        throw new ConflictException({ code: result.status, message: shortfallText(result.status) });
      case "NOT_SENT":
        throw new ConflictException({
          code: "NOT_SENT",
          message: "The payment could not be sent. Nothing was sent. Please start it again.",
        });
    }
  }
}

function shortfallText(status: "NOT_AVAILABLE" | "INSUFFICIENT_BALANCE" | "GAS_FUNDING_REQUIRED") {
  switch (status) {
    case "INSUFFICIENT_BALANCE":
      return "Your wallet doesn't hold enough for this payment (and the network fee). Nothing was sent.";
    case "GAS_FUNDING_REQUIRED":
      return "Your wallet needs a little CELO to pay the network fee. Nothing was sent.";
    case "NOT_AVAILABLE":
      return "This payment can't be confirmed this way.";
  }
}
