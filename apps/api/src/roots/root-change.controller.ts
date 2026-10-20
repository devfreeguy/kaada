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
  Optional,
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
import { ClientIp } from "../security/client-ip.js";
import { RECOVERY_SWITCH } from "../recovery/recovery-switch.js";
import type { RecoverySwitch } from "../recovery/recovery-switch.js";
import { RELAYER_SPEND_LIMITER } from "../security/relayer-spend-limiter.js";
import type { RelayerSpendLimiter } from "../security/relayer-spend-limiter.js";

import { attestationEvidenceSchema, challengeView } from "../attestation/attestation.schema.js";

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

/** The NATIVE route: a device-key credential may carry platform evidence. The web route's strict schema refuses it. */
const nativePrepareBody = z.strictObject({
  kind: z.enum(["ROTATE_ROOT", "ENROLL_BACKUP"]),
  credential: z.strictObject({
    type: z.literal("DEVICE_KEY"),
    publicKeyX: hex64,
    publicKeyY: hex64,
    challenge: z.string().regex(/^0x[0-9a-f]{64}$/),
    r: hex64,
    s: hex64,
    attestation: attestationEvidenceSchema.optional(),
  }),
});
const attestationChallengeBody = z.strictObject({
  kind: z.enum(["ROTATE_ROOT", "ENROLL_BACKUP"]),
  platform: z.enum(["ANDROID", "IOS"]),
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
        throw new UnauthorizedException("this link is not valid or has expired", { cause: error });
      case "CREDENTIAL_REJECTED":
        throw new BadRequestException("your credential could not be verified", { cause: error });
      case "WALLET_NOT_ACTIVE":
        throw new ConflictException("set up your wallet first", { cause: error });
      case "ROOT_CHANGE_CONFLICT":
        throw new ConflictException("another change is in progress", { cause: error });
      case "ROOT_CHANGE_REJECTED":
      case "BUNDLER_REJECTED":
        throw new BadRequestException("this change is not available right now", { cause: error });
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
    @Optional() @Inject(RELAYER_SPEND_LIMITER) private readonly spend?: RelayerSpendLimiter,
    @Optional() @Inject(RECOVERY_SWITCH) private readonly off?: RecoverySwitch,
  ) {}

  /** Preparing a root change can deploy a validator clone paid by the relayer: counted per address, then per person. */
  private async limitChange(setup: WalletSetupService, token: string, ip: string): Promise<string> {
    await this.spend?.checkIp("device-key", ip);
    const userId = await setup.userForView(token);
    await this.spend?.checkUser("device-key", userId);
    return userId;
  }

  private services() {
    if (!this.setup || !this.changes) {
      throw new ServiceUnavailableException("root changes are not enabled");
    }
    if (this.off?.off)
      throw new ServiceUnavailableException("root changes are temporarily unavailable");
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
  async prepare(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
    @ClientIp() ip = "",
  ) {
    const { setup, changes } = this.services();
    const parsed = prepareBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      const prepared = await changes.prepare(
        await this.limitChange(setup, bearer(authorization), ip),
        parsed.data.kind,
        parsed.data.credential,
      );
      return { ...prepared, expiresAt: prepared.expiresAt.toISOString() };
    } catch (error) {
      return httpError(error);
    }
  }

  /** Native: the one-time nonce a device passes to the platform when it generates the NEW key (bound to this wallet). */
  @Post("attestation/challenge")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async attestationChallenge(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const { setup, changes } = this.services();
    const parsed = attestationChallengeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      return challengeView(
        await changes.issueAttestationChallenge(
          await setup.userForView(bearer(authorization)),
          parsed.data.kind,
          parsed.data.platform,
        ),
      );
    } catch (error) {
      return httpError(error);
    }
  }

  /** Native: like `changes`, but platform evidence for the new device key is considered (the route says it is native). */
  @Post("native/changes")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async prepareNative(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
    @ClientIp() ip = "",
  ) {
    const { setup, changes } = this.services();
    const parsed = nativePrepareBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      const prepared = await changes.prepare(
        await this.limitChange(setup, bearer(authorization), ip),
        parsed.data.kind,
        parsed.data.credential,
        "native",
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
