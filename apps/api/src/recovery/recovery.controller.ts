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
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { isKaadaError } from "@kaada/domain";
import { z } from "zod";

import type { WalletSetupService } from "../core/wallets/setup-service.js";
import { WALLET_SETUP_SERVICE } from "../wallet/wallet.tokens.js";
import { RECOVERY_RUNTIME } from "./recovery.tokens.js";
import type { RecoveryRuntime } from "./recovery.runtime.js";

import {
  attestationChallengeSchema,
  attestationEvidenceSchema,
  challengeView,
} from "../attestation/attestation.schema.js";

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
const startBody = z.strictObject({ email: z.string().max(254) });
const verifyBody = z.strictObject({ code: z.string().max(12) });
const passkeyBody = z.strictObject({
  response: z.looseObject({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal("public-key"),
    response: z.looseObject({
      clientDataJSON: z.string().min(1).max(8192),
      attestationObject: z.string().min(1).max(16384),
    }),
  }),
});
const deviceBody = z.strictObject({ publicKeyX: hex(32), publicKeyY: hex(32) });
/** The NATIVE route: the same, plus platform evidence the server verifies. The web route's strict schema refuses it. */
const nativeDeviceBody = z.strictObject({
  publicKeyX: hex(32),
  publicKeyY: hex(32),
  attestation: attestationEvidenceSchema.optional(),
});
const proofBody = z.strictObject({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });
/** A passkey assertion (an object) or a device signature (a hex string): validated by the chain adapter. */
const materialBody = z.strictObject({
  material: z.union([
    z.string().max(1024),
    z.looseObject({}).refine((v) => JSON.stringify(v).length < 20_000),
  ]),
});
const pinBody = z.strictObject({ pin: z.string().max(16) });
const configurationPrepareBody = z.strictObject({
  recoveryAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  delaySeconds: z.number().int().min(1).max(31_536_000).optional(),
});
const configurationSubmitBody = z.strictObject({
  configurationId: z.uuid(),
  material: materialBody.shape.material,
});

/** The bearer token of a recovery session, a cancel link or a setup link. The ONLY identity these endpoints accept. */
function bearer(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match?.[1]) throw new UnauthorizedException("a recovery token is required");
  return match[1];
}

function httpError(error: unknown): never {
  if (isKaadaError(error)) {
    switch (error.code) {
      case "RECOVERY_SESSION_INVALID":
      case "SETUP_SESSION_INVALID":
        throw new UnauthorizedException("this recovery link is not valid or has expired");
      case "RECOVERY_RATE_LIMITED":
        throw new HttpException("too many requests, try again later", HttpStatus.TOO_MANY_REQUESTS);
      case "RECOVERY_REJECTED":
      case "CREDENTIAL_REJECTED":
      case "PIN_REJECTED":
        throw new BadRequestException(error.message);
      case "RECOVERY_CONFLICT":
      case "RECOVERY_NOT_CONFIGURED":
      case "WALLET_NOT_ACTIVE":
      case "ROOT_CREDENTIAL_REQUIRED":
        throw new ConflictException(error.message);
      case "RECOVERY_CHAIN_UNAVAILABLE":
      case "RECOVERY_BLOCKED":
      case "BUNDLER_UNAVAILABLE":
        throw new ServiceUnavailableException("recovery is temporarily unavailable");
      default:
        break;
    }
  }
  throw error;
}

/**
 * The recovery API. Identity is always an opaque, short-lived token (a session token after the email was verified, a
 * one-use cancel link token, or a wallet setup link); a body or query can never name a user, an account or an attempt.
 * Tokens travel in the Authorization header only, never in a URL, and every response is `no-store`. Email verification alone
 * unlocks nothing on chain: only the Recovery Code proof does, and only for the exact root that was proposed.
 */
@Controller({ path: "recovery", version: "1" })
export class RecoveryController {
  constructor(
    @Inject(RECOVERY_RUNTIME) private readonly runtime: RecoveryRuntime | null,
    @Inject(WALLET_SETUP_SERVICE) private readonly setup: WalletSetupService | null,
  ) {}

  private services(): RecoveryRuntime {
    if (!this.runtime) throw new ServiceUnavailableException("account recovery is not enabled");
    return this.runtime;
  }

  // ── start and email ──

  @Post("start")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  async start(@Body() body: unknown, @Ip() ip: string) {
    const parsed = startBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("enter a valid email address");
    try {
      // The same answer for every email: an opaque token and nothing about the account.
      return await this.services().flow.start({ email: parsed.data.email, ip });
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("resend")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  async resend(@Headers("authorization") authorization?: string) {
    try {
      await this.services().flow.resend(bearer(authorization));
      return { status: "ok" };
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("verify-email")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async verifyEmail(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const parsed = verifyBody.safeParse(body);
    if (!parsed.success)
      throw new UnauthorizedException("this recovery link is not valid or has expired");
    try {
      return await this.services().flow.verifyEmail(bearer(authorization), parsed.data.code);
    } catch (error) {
      return httpError(error);
    }
  }

  @Get("status")
  @Header("Cache-Control", "no-store")
  async status(@Headers("authorization") authorization?: string) {
    try {
      return await this.services().flow.status(bearer(authorization));
    } catch (error) {
      return httpError(error);
    }
  }

  // ── the new root and the Recovery Code proof ──

  @Post("passkey/options")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async passkeyOptions(@Headers("authorization") authorization?: string) {
    try {
      return await this.services().flow.beginNewPasskey(bearer(authorization));
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("root/passkey")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async passkeyRoot(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const parsed = passkeyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      return await this.services().flow.proposePasskeyRoot(
        bearer(authorization),
        parsed.data.response,
      );
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("root/device-key")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async deviceRoot(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const parsed = deviceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      // This route is the WEB enrolment path: the server, not the client, decides the channel. A key from here can never
      // become TRUSTED_DEVICE; that needs a verified platform attestation on a native route.
      return await this.services().flow.proposeDeviceRoot(bearer(authorization), {
        ...parsed.data,
        channel: "web",
      });
    } catch (error) {
      return httpError(error);
    }
  }

  /** Native: the one-time nonce the new device passes to the platform when it generates its key (bound to this recovery). */
  @Post("root/attestation/challenge")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async attestationChallenge(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const parsed = attestationChallengeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      return challengeView(
        await this.services().flow.issueAttestationChallenge(
          bearer(authorization),
          parsed.data.platform,
        ),
      );
    } catch (error) {
      return httpError(error);
    }
  }

  /** Native: like `root/device-key`, but platform evidence is considered (the route, not the body, says it is native). */
  @Post("root/device-key/native")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async nativeDeviceRoot(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const parsed = nativeDeviceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    const platform = parsed.data.attestation?.platform;
    try {
      return await this.services().flow.proposeDeviceRoot(bearer(authorization), {
        publicKeyX: parsed.data.publicKeyX,
        publicKeyY: parsed.data.publicKeyY,
        attestation: parsed.data.attestation,
        channel:
          platform === "IOS" ? "native-ios" : platform === "ANDROID" ? "native-android" : "unknown",
      });
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("proof")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async proof(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const parsed = proofBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("the signature is malformed");
    try {
      return await this.services().flow.submitProof(bearer(authorization), parsed.data.signature);
    } catch (error) {
      return httpError(error);
    }
  }

  // ── finalization and after ──

  @Post("finalize")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async finalize(@Headers("authorization") authorization?: string) {
    const { finalizer } = this.services();
    try {
      const outcome = await finalizer.finalizeForSession(bearer(authorization));
      return { outcome: outcome.outcome, ...("reason" in outcome && { reason: outcome.reason }) };
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("signing-proof/options")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async signingProofOptions(@Headers("authorization") authorization?: string) {
    try {
      return await this.services().finalizer.beginSigningProof(bearer(authorization));
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("signing-proof")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async signingProof(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const parsed = materialBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      return await this.services().finalizer.completeSigningProof(
        bearer(authorization),
        parsed.data.material,
      );
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("pin")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async resetPin(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const parsed = pinBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("a PIN is exactly six digits");
    try {
      return await this.services().finalizer.resetPin(bearer(authorization), parsed.data.pin);
    } catch (error) {
      return httpError(error);
    }
  }

  // ── cancellation by the existing root, and "this was not me" (the cancel link token) ──

  @Post("cancel/prepare")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async cancelPrepare(@Headers("authorization") authorization?: string) {
    try {
      return await this.services().flow.prepareCancel(bearer(authorization));
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("cancel")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async cancel(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const parsed = materialBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      return await this.services().flow.submitCancel(bearer(authorization), parsed.data.material);
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("report")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async report(@Headers("authorization") authorization?: string) {
    try {
      return await this.services().flow.report(bearer(authorization));
    } catch (error) {
      return httpError(error);
    }
  }

  // ── a new Recovery Code (after a recovery, or the first time) ──

  /** The account and chain a new Recovery Code is bound to (so the browser can derive its verifier before preparing). */
  @Get("configuration/context")
  @Header("Cache-Control", "no-store")
  async configurationContext(@Headers("authorization") authorization?: string) {
    try {
      return await this.services().configuration.describe(
        await this.identify(bearer(authorization)),
      );
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("configuration/prepare")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async configurationPrepare(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const parsed = configurationPrepareBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      const userId = await this.identify(bearer(authorization));
      return await this.services().configuration.prepare({
        userId,
        recoveryAddress: parsed.data.recoveryAddress,
        ...(parsed.data.delaySeconds !== undefined && { delaySeconds: parsed.data.delaySeconds }),
      });
    } catch (error) {
      return httpError(error);
    }
  }

  @Post("configuration")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async configurationSubmit(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const parsed = configurationSubmitBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    try {
      const userId = await this.identify(bearer(authorization));
      const configuration = await this.services().configuration.submit({
        userId,
        configurationId: parsed.data.configurationId,
        material: parsed.data.material,
      });
      return { status: configuration.status, delaySeconds: configuration.delaySeconds };
    } catch (error) {
      return httpError(error);
    }
  }

  /** A COMPLETED recovery session, or a wallet setup link, identifies the user who may arm a Recovery Code. */
  private async identify(token: string): Promise<string> {
    const { finalizer } = this.services();
    try {
      return await finalizer.completedSessionUser(token);
    } catch (error) {
      if (!isKaadaError(error) || !this.setup) throw error;
    }
    return this.setup.userForView(token);
  }
}
