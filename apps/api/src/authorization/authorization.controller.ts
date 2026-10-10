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
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { AppConfig } from "@kaada/config";
import { isKaadaError } from "@kaada/domain";
import { z } from "zod";

import { APP_CONFIG } from "../config/config.module.js";
import type { PaymentAuthorizationService } from "../core/authorization/payment-authorization-service.js";
import { RateLimiter } from "../core/authorization/rate-limiter.js";
import type { AuthorizationSessionService } from "../core/authorization/session-service.js";
import { hashOpaqueToken } from "../core/authorization/token.js";
import {
  AUTHORIZATION_SESSION_SERVICE,
  PAYMENT_AUTHORIZATION_SERVICE,
} from "./authorization.tokens.js";

const authorizeBody = z.strictObject({ pin: z.string().max(16) });
const devLinkBody = z.strictObject({ sessionId: z.uuid(), userId: z.uuid() });

/** The bearer token of an authorization link. It is the ONLY identity these endpoints accept. */
function bearer(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match?.[1]) throw new UnauthorizedException("an authorization token is required");
  return match[1];
}

function httpError(error: unknown): never {
  if (isKaadaError(error, "AUTHORIZATION_SESSION_INVALID")) {
    throw new UnauthorizedException("this authorization link is not valid or has expired");
  }
  throw error;
}

/**
 * The secure page's API. The identity is the opaque link token: the user, wallet, intent and route
 * come from the session row, so nothing in a body or query can name them. The PIN travels only in the
 * request body of one POST, is never echoed, and is not logged (the logger redacts it as well).
 */
@Controller({ path: "authorization", version: "1" })
export class AuthorizationController {
  // Per link and per address: a second line of defence; the PIN lockout in the database is authoritative.
  private readonly perToken = new RateLimiter(12, 60_000);
  private readonly perAddress = new RateLimiter(30, 60_000);

  constructor(
    @Inject(AUTHORIZATION_SESSION_SERVICE)
    private readonly sessions: AuthorizationSessionService | null,
    @Inject(PAYMENT_AUTHORIZATION_SERVICE)
    private readonly payments: PaymentAuthorizationService | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private sessionService(): AuthorizationSessionService {
    if (!this.sessions) throw new ServiceUnavailableException("authorization is not enabled");
    return this.sessions;
  }

  @Get()
  @Header("Cache-Control", "no-store")
  async view(@Headers("authorization") authorization?: string) {
    try {
      const view = await this.sessionService().view(bearer(authorization));
      return {
        summary: view.summary,
        fees: view.fees,
        expiresAt: view.expiresAt.toISOString(),
        indicative: view.indicative,
        ...(view.mock && { mock: true }),
        pin: {
          isSet: view.pin.isSet,
          resetRequired: view.pin.resetRequired,
          ...(view.pin.lockedUntil && { lockedUntil: view.pin.lockedUntil.toISOString() }),
        },
      };
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("authorize")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async authorize(
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    if (!this.payments) throw new ServiceUnavailableException("authorization is not enabled");
    const token = bearer(authorization);
    if (!this.perToken.allow(hashOpaqueToken(token)) || !this.perAddress.allow(ip || "unknown")) {
      throw new HttpException("too many attempts, wait a moment", HttpStatus.TOO_MANY_REQUESTS);
    }
    const parsed = authorizeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");

    try {
      const result = await this.payments.authorize(token, parsed.data.pin);
      switch (result.status) {
        case "AUTHORIZED":
          return { status: "AUTHORIZED", expiresAt: result.authorization.expiresAt.toISOString() };
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
          throw new BadRequestException({ code: "INVALID_FORMAT", message: "Enter four digits." });
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return httpError(error);
    }
  }

  /**
   * DEVELOPMENT ONLY: stands in for a channel that renders the "Authorize payment" button. It does
   * not exist in production. The session must belong to the user named (a channel knows its user).
   */
  @Post("dev/links")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async devLink(@Body() body: unknown) {
    if (this.config.nodeEnv === "production") throw new NotFoundException();
    const parsed = devLinkBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      const link = await this.sessionService().issueLink(parsed.data);
      return { url: link.url, expiresAt: link.expiresAt.toISOString() };
    } catch (error) {
      return httpError(error);
    }
  }
}
