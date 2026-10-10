import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { AppConfig } from "@kaada/config";
import type { Repositories } from "@kaada/database";
import { createId, isKaadaError } from "@kaada/domain";
import type { Wallet } from "@kaada/domain";
import { z } from "zod";

import { APP_CONFIG } from "../config/config.module.js";
import type { WalletBalanceService } from "../core/wallets/balance-service.js";
import type { WalletSetupService } from "../core/wallets/setup-service.js";
import {
  WALLET_BALANCE_SERVICE,
  WALLET_REPOSITORIES,
  WALLET_SETUP_SERVICE,
} from "./wallet.tokens.js";

/** What a browser may see of a wallet. No provider identifiers, no internal reasons. */
export interface WalletView {
  id: string;
  chainId: number;
  address: string | null;
  status: Wallet["status"];
  deploymentStatus: Wallet["deployment"];
  provisionedAt: string | null;
}

function walletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    chainId: wallet.chainId,
    address: wallet.address ?? null,
    status: wallet.status,
    deploymentStatus: wallet.deployment,
    provisionedAt: wallet.provisionedAt?.toISOString() ?? null,
  };
}

/** The shape of a WebAuthn registration response; the verifier checks everything inside it. */
const registrationResponseSchema = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: z.string().min(1).max(8192),
    attestationObject: z.string().min(1).max(65536),
  }),
});

const devSessionSchema = z.strictObject({
  userId: z.uuid().optional(),
  /** SECURITY: a link for someone whose wallet is already active (to set or change the PIN). */
  purpose: z.enum(["SETUP", "SECURITY"]).optional(),
});

/** The bearer token of a setup link. It is the ONLY identity these endpoints accept. */
function bearer(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match?.[1]) throw new UnauthorizedException("a setup token is required");
  return match[1];
}

/** Maps domain failures to safe HTTP answers. Messages here are fixed; none carries internal detail. */
function httpError(error: unknown): never {
  if (isKaadaError(error)) {
    switch (error.code) {
      case "SETUP_SESSION_INVALID":
        throw new UnauthorizedException("this setup link is not valid or has expired");
      case "CREDENTIAL_REJECTED":
        throw new BadRequestException("the passkey could not be verified");
      case "WALLET_ALREADY_SETUP":
        throw new ConflictException("this wallet is already set up or has a passkey");
      case "ROOT_CREDENTIAL_REQUIRED":
        throw new ConflictException("register a passkey first");
      case "WALLET_NOT_ACTIVE":
        throw new NotFoundException("no active wallet yet");
      case "WALLET_PROVISIONING_FAILED":
        throw new BadGatewayException("the wallet could not be created right now; try again");
      default:
        break;
    }
  }
  throw error;
}

/**
 * Thin HTTP edge around the wallet services. Identity is a setup-link token; a request body or
 * query can never name a user. No signing, no payment, no provider SDK type crosses this edge.
 */
@Controller({ path: "wallet", version: "1" })
export class WalletController {
  constructor(
    @Inject(WALLET_SETUP_SERVICE) private readonly setup: WalletSetupService | null,
    @Inject(WALLET_BALANCE_SERVICE) private readonly balances: WalletBalanceService | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WALLET_REPOSITORIES) private readonly repositories: Repositories,
  ) {}

  private service(): WalletSetupService {
    if (!this.setup) throw new ServiceUnavailableException("wallets are not enabled");
    return this.setup;
  }

  @Post("passkeys/registration/options")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async registrationOptions(@Headers("authorization") authorization?: string) {
    try {
      return await this.service().beginRegistration(bearer(authorization));
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("passkeys/registration/verify")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async registrationVerify(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const token = bearer(authorization);
    if (!registrationResponseSchema.safeParse(body).success) {
      throw new BadRequestException("malformed registration response");
    }
    try {
      const done = await this.service().completeRegistration(token, body);
      return { status: done.status, wallet: done.wallet ? walletView(done.wallet) : null };
    } catch (error) {
      return httpError(error);
    }
  }

  /** Finishes a setup whose passkey is registered but whose wallet was not created (a retry). */
  @Post("setup/finalize")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async finalize(@Headers("authorization") authorization?: string) {
    try {
      const done = await this.service().finalize(bearer(authorization));
      return { status: done.status, wallet: done.wallet ? walletView(done.wallet) : null };
    } catch (error) {
      return httpError(error);
    }
  }

  @Get()
  @Header("Cache-Control", "no-store")
  async details(@Headers("authorization") authorization?: string) {
    try {
      const view = await this.service().view(bearer(authorization));
      return {
        setup: { status: view.status, expiresAt: view.expiresAt.toISOString() },
        passkeyRegistered: view.passkeyRegistered,
        wallet: view.wallet ? walletView(view.wallet) : null,
      };
    } catch (error) {
      return httpError(error);
    }
  }

  @Get("balances")
  @Header("Cache-Control", "no-store")
  async walletBalances(@Headers("authorization") authorization?: string) {
    if (!this.balances) throw new ServiceUnavailableException("wallets are not enabled");
    try {
      const userId = await this.service().userForView(bearer(authorization));
      const view = await this.balances.forUser(userId);
      return {
        wallet: {
          address: view.wallet.address,
          chainId: view.wallet.chainId,
          deploymentStatus: view.wallet.deployment,
        },
        balances: view.balances.map((line) => ({
          assetId: line.assetId,
          symbol: line.symbol,
          money: line.money,
          formatted: line.formatted,
        })),
      };
    } catch (error) {
      return httpError(error);
    }
  }

  /**
   * DEVELOPMENT ONLY: stands in for a channel that has authenticated a user (Telegram and WhatsApp
   * arrive later). It does not exist in production. Omit userId to get a throwaway user.
   */
  @Post("dev/setup-sessions")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async devSetupSession(@Body() body: unknown) {
    if (this.config.nodeEnv === "production") throw new NotFoundException();
    const parsed = devSessionSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException("invalid request");
    let userId = parsed.data.userId;
    if (userId === undefined) {
      userId = createId();
      await this.repositories.users.create({ id: userId, displayName: "Dev user" });
    }
    try {
      const created = await this.service().createSession(userId, {
        existingWallet: parsed.data.purpose === "SECURITY",
      });
      return { userId, url: created.url, expiresAt: created.expiresAt.toISOString() };
    } catch (error) {
      return httpError(error);
    }
  }
}
