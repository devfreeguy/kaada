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
  Param,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { isKaadaError } from "@kaada/domain";
import type { RootProof } from "@kaada/domain";
import { z } from "zod";

import type { RootChangeService } from "../core/roots/root-change-service.js";
import type { WalletSetupService } from "../core/wallets/setup-service.js";
import { WALLET_SETUP_SERVICE } from "../wallet/wallet.tokens.js";
import { rootProofSchema } from "./root-proof.schema.js";
import { ROOT_CHANGE_SERVICE } from "./roots.tokens.js";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const deviceKeyBody = z.strictObject({ publicKeyX: hex64, publicKeyY: hex64 });

const newCredentialSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("PASSKEY"),
    response: z.looseObject({
      id: z.string().min(1).max(1024),
      rawId: z.string().min(1).max(1024),
      type: z.literal("public-key"),
      response: z.looseObject({
        clientDataJSON: z.string().min(1).max(8192),
        attestationObject: z.string().min(1).max(65536),
      }),
    }),
  }),
  z.strictObject({
    type: z.literal("DEVICE_KEY"),
    publicKeyX: hex64,
    publicKeyY: hex64,
    challenge: z.string().regex(/^0x[0-9a-f]{64}$/),
    r: hex64,
    s: hex64,
  }),
]);

const prepareBody = z.strictObject({
  kind: z.enum(["ROTATE_ROOT", "ENROLL_BACKUP"]),
  credential: newCredentialSchema,
});

const completeBody = z.strictObject({ proof: rootProofSchema });

function bearer(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match?.[1]) throw new UnauthorizedException("a security link token is required");
  return match[1];
}

function httpError(error: unknown): never {
  if (isKaadaError(error)) {
    switch (error.code) {
      case "SETUP_SESSION_INVALID":
        throw new UnauthorizedException("this link is not valid or has expired");
      case "CREDENTIAL_REJECTED":
        throw new BadRequestException("your credential could not be verified");
      case "WALLET_NOT_ACTIVE":
        throw new ConflictException("set up your wallet first");
      case "ROOT_CHANGE_CONFLICT":
        throw new ConflictException("another change is in progress");
      case "ROOT_CHANGE_REJECTED":
      case "BUNDLER_REJECTED":
        throw new BadRequestException("this change is not available right now");
      default:
        break;
    }
  }
  throw error;
}

/**
 * Change a wallet's credentials with its ROOT: rotate the root to a fresh credential, or enrol a backup. Identity is a security
 * link token (the same one that sets the PIN); the authority is the current root's proof over the operation the SERVER fixed.
 * Both root types work through the same calls: the response says which signer the client must show.
 */
@Controller({ path: "wallet/root", version: "1" })
export class RootChangeController {
  constructor(
    @Inject(WALLET_SETUP_SERVICE) private readonly setup: WalletSetupService | null,
    @Inject(ROOT_CHANGE_SERVICE) private readonly changes: RootChangeService | null,
  ) {}

  private services() {
    if (!this.setup || !this.changes) {
      throw new ServiceUnavailableException("root changes are not enabled");
    }
    return { setup: this.setup, changes: this.changes };
  }

  @Post("passkey/options")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async passkeyOptions(@Headers("authorization") authorization?: string) {
    const { setup, changes } = this.services();
    try {
      return await changes.beginPasskey(await setup.userForView(bearer(authorization)));
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("device-key/options")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async deviceKeyOptions(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const { setup, changes } = this.services();
    const parsed = deviceKeyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      return await changes.beginDeviceKey(
        await setup.userForView(bearer(authorization)),
        parsed.data,
      );
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("changes")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async prepare(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const { setup, changes } = this.services();
    const parsed = prepareBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      const prepared = await changes.prepare(
        await setup.userForView(bearer(authorization)),
        parsed.data.kind,
        parsed.data.credential,
      );
      return { ...prepared, expiresAt: prepared.expiresAt.toISOString() };
    } catch (error) {
      return httpError(error);
    }
  }

  /** Takes the current root's proof and nothing else: no operation, address or calldata. */
  @Post("changes/:id/complete")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async complete(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const { setup, changes } = this.services();
    const parsed = completeBody.safeParse(body);
    if (!parsed.success || !z.uuid().safeParse(id).success) {
      throw new BadRequestException("invalid request");
    }
    try {
      const view = await changes.complete(
        await setup.userForView(bearer(authorization)),
        id,
        parsed.data.proof as RootProof,
      );
      return { ...view, expiresAt: view.expiresAt.toISOString() };
    } catch (error) {
      return httpError(error);
    }
  }

  @Get("changes/:id")
  @Header("Cache-Control", "no-store")
  async status(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    const { setup, changes } = this.services();
    if (!z.uuid().safeParse(id).success) throw new BadRequestException("invalid request");
    try {
      const view = await changes.status(await setup.userForView(bearer(authorization)), id);
      return { ...view, expiresAt: view.expiresAt.toISOString() };
    } catch (error) {
      return httpError(error);
    }
  }
}
