import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { isKaadaError } from "@kaada/domain";
import { z } from "zod";

import type { PinEnrollmentService } from "../core/authorization/pin-enrollment.js";
import type { TransactionPinService } from "../core/authorization/pin-service.js";
import type { WalletSetupService } from "../core/wallets/setup-service.js";
import { WALLET_SETUP_SERVICE } from "../wallet/wallet.tokens.js";
import { PIN_ENROLLMENT_SERVICE, TRANSACTION_PIN_SERVICE } from "./authorization.tokens.js";

const setPinBody = z.strictObject({
  pin: z.string().max(16),
  assertion: z.looseObject({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal("public-key"),
    response: z.looseObject({
      clientDataJSON: z.string().min(1).max(8192),
      authenticatorData: z.string().min(1).max(8192),
      signature: z.string().min(1).max(8192),
    }),
  }),
});

function bearer(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match?.[1]) throw new UnauthorizedException("a setup token is required");
  return match[1];
}

function httpError(error: unknown): never {
  if (isKaadaError(error)) {
    switch (error.code) {
      case "SETUP_SESSION_INVALID":
        throw new UnauthorizedException("this link is not valid or has expired");
      case "CREDENTIAL_REJECTED":
        throw new BadRequestException("your passkey could not be verified");
      case "PIN_REJECTED":
        throw new BadRequestException("a PIN is exactly four digits");
      case "WALLET_NOT_ACTIVE":
        throw new ConflictException("set up your wallet before creating a PIN");
      default:
        break;
    }
  }
  throw error;
}

/**
 * Create or change the transaction PIN. Identity comes from the wallet setup link; the strong
 * credential is a fresh passkey assertion. The old PIN alone never changes the PIN, and "forgot PIN"
 * has no reset here: it needs account recovery, which is a later build.
 */
@Controller({ path: "wallet/pin", version: "1" })
export class PinController {
  constructor(
    @Inject(WALLET_SETUP_SERVICE) private readonly setup: WalletSetupService | null,
    @Inject(TRANSACTION_PIN_SERVICE) private readonly pins: TransactionPinService | null,
    @Inject(PIN_ENROLLMENT_SERVICE) private readonly enrollment: PinEnrollmentService | null,
  ) {}

  private services() {
    if (!this.setup || !this.pins || !this.enrollment) {
      throw new ServiceUnavailableException("wallets are not enabled");
    }
    return { setup: this.setup, pins: this.pins, enrollment: this.enrollment };
  }

  @Get()
  @Header("Cache-Control", "no-store")
  async status(@Headers("authorization") authorization?: string) {
    const { setup, pins } = this.services();
    try {
      const status = await pins.status(await setup.userForView(bearer(authorization)));
      return {
        isSet: status.isSet,
        resetRequired: status.resetRequired,
        ...(status.lockedUntil && { lockedUntil: status.lockedUntil.toISOString() }),
      };
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("options")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async options(@Headers("authorization") authorization?: string) {
    const { setup, enrollment } = this.services();
    try {
      return await enrollment.begin(await setup.userForView(bearer(authorization)));
    } catch (error) {
      return httpError(error);
    }
  }

  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async setPin(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const { setup, enrollment } = this.services();
    const token = bearer(authorization);
    const parsed = setPinBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      const outcome = await enrollment.complete(await setup.userForView(token), parsed.data);
      return { status: outcome };
    } catch (error) {
      return httpError(error);
    }
  }

  /** There is no self-service reset: say so, cleanly. */
  @Post("forgot")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async forgot(@Headers("authorization") authorization?: string) {
    const { setup, pins } = this.services();
    try {
      await setup.userForView(bearer(authorization));
      return pins.forgotPin();
    } catch (error) {
      return httpError(error);
    }
  }
}
