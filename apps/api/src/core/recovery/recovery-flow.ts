import { randomBytes } from "node:crypto";

import { deviceKeyIdFromPoint, deviceKeyPayload, isOnP256Curve } from "@kaada/contracts";
import type { EnrolmentChannel } from "@kaada/contracts";
import {
  CELO_CHAIN_ID,
  KaadaError,
  RECOVERY_AUDIT_EVENTS,
  createId,
  isKaadaError,
  isWalletActive,
} from "@kaada/domain";
import type {
  DeviceSecurityTier,
  ProposedRoot,
  RecoveryAttempt,
  RecoveryConfiguration,
  RecoveryTypedData,
  RootCredentialData,
  Wallet,
  WalletCredential,
} from "@kaada/domain";

import { RateLimiter } from "../authorization/rate-limiter.js";
import { TOTP_CODE_PATTERN } from "./totp.js";
import type { RateLimit } from "../authorization/rate-limiter.js";
import { hashOpaqueToken, newOpaqueToken } from "../authorization/token.js";
import {
  audit,
  invalidSession,
  isHash,
  readToken,
  resolveAttempt,
  sha256Hex,
  statusView,
} from "./context.js";
import type { RecoveryContext, RecoveryStatusView } from "./context.js";
import {
  EMAIL_CODE_PATTERN,
  hashEmailCode,
  newEmailCode,
  normalizeEmail,
  sameDigest,
} from "./email-code.js";
import {
  challengeEmail,
  cancelUrl,
  recoveryCancelledMessage,
  recoveryNotConfiguredEmail,
  recoveryStartedMessage,
  recoveryUnavailableEmail,
} from "./messages.js";
import type { RecoveryRepositories } from "./ports.js";

import { resolveDeviceTier } from "../attestation/device-tier-service.js";
import type {
  AttestationEvidence,
  DeviceTierResolver,
  IssuedAttestationChallenge,
} from "../attestation/device-tier-service.js";

const HEX64 = /^[0-9a-f]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the browser needs to sign the commitment with the Recovery Code key. */
export interface RootProposal {
  typedData: RecoveryTypedData;
  chainId: number;
  account: string;
  recoveryAddress: string;
  root: { kind: "PASSKEY" | "DEVICE_KEY"; validator: string; rootId: string };
  /** Unix seconds after which the signatures are void. */
  deadline: string;
}

/** What the existing root must sign to cancel (a passkey assertion or a device-key signature) . */
export interface RootSigningRequest {
  /** The 32-byte userOpHash the root must sign (hex). */
  challenge: string;
  rootKind: "PASSKEY" | "DEVICE_KEY";
  chainId: number;
  /** PASSKEY: the WebAuthn request options (the challenge is base64url). */
  passkey?: { challenge: string; rpId: string; userVerification: "required" };
  /** DEVICE_KEY: what the device signs (see KaadaDeviceKeyValidator) . */
  /** DEVICE_KEY: `payload` is the exact hex the device signs (ECDSA P-256 / SHA-256); the material sent back is keyId || r || s. */
  device?: { chainId: number; validator: string; account: string; keyId: string; payload: string };
}

export interface DeviceRootInput {
  publicKeyX: string;
  publicKeyY: string;
  /** Where the request came from, as OBSERVED by the HTTP edge (never read from the request body). */
  channel: EnrolmentChannel;
  /** Platform evidence from a native client. A claim until the server verifies it; refused on the web route. */
  attestation?: AttestationEvidence | undefined;
}

export interface RecoveryFlowDeps {
  context: RecoveryContext;
  /** Absent unless device attestation is enabled: then a key's tier is whatever its route implies and never more. */
  deviceTiers?: DeviceTierResolver;
  limiters?: { start?: RateLimit; ip?: RateLimit; step?: RateLimit };
}

/** The challenge a WebAuthn response was made for, read from clientDataJSON. */
function challengeOf(response: unknown): string | undefined {
  const inner = (response as { response?: { clientDataJSON?: unknown } } | null)?.response;
  if (typeof inner?.clientDataJSON !== "string") return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(inner.clientDataJSON, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    return typeof decoded.challenge === "string" ? decoded.challenge : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The recovery flow up to and including the on-chain initiation, plus cancellation by the existing root. Four things must all
 * hold before a recovery completes: the registered email was verified, the Recovery Code signed the EXACT stored commitment
 * (checked against the stored verifier), a current authenticator-app code was accepted, and the contract's own delay passed.
 * Email and the authenticator code are Kaada's gates; the Recovery Code signature is what the chain itself requires, so Kaada
 * alone can never start, approve or complete a recovery.
 */
export class RecoveryFlowService {
  private readonly ctx: RecoveryContext;
  private readonly startLimiter: RateLimit;
  private readonly ipLimiter: RateLimit;
  private readonly stepLimiter: RateLimit;

  constructor(private readonly deps: RecoveryFlowDeps) {
    this.ctx = deps.context;
    const now = () => this.ctx.now().getTime();
    this.startLimiter = deps.limiters?.start ?? new RateLimiter(5, 60 * 60 * 1000, now);
    this.ipLimiter = deps.limiters?.ip ?? new RateLimiter(20, 60 * 60 * 1000, now);
    this.stepLimiter = deps.limiters?.step ?? new RateLimiter(30, 10 * 60 * 1000, now);
  }

  // ───────────────────────────────── start & email ─────────────────────────────────

  /**
   * Starts (or resumes) a recovery for an email. The answer is the same whether or not the email belongs to an account,
   * has a wallet, or has recovery set up: always a fresh opaque token. Nothing but that token is returned, and the email
   * code is sent to the registered address only.
   */
  async start(input: { email: unknown; ip?: string }): Promise<{ token: string }> {
    const email = normalizeEmail(input.email);
    if (!email) throw new KaadaError("RECOVERY_REJECTED", "enter a valid email address");
    const limited =
      !(await this.startLimiter.allow(`email:${sha256Hex(email)}`)) ||
      (input.ip !== undefined && !(await this.ipLimiter.allow(`ip:${input.ip}`)));
    if (limited)
      throw new KaadaError("RECOVERY_RATE_LIMITED", "too many requests, try again later");

    const token = newOpaqueToken();
    const sessionTokenHash = hashOpaqueToken(token);
    const now = this.ctx.now();

    const identity = await this.ctx.uow.read.identities.findByExternalId("EMAIL", email);
    if (!identity) return { token };
    const wallet = await this.ctx.uow.read.wallets.findEmbedded(identity.userId, CELO_CHAIN_ID);
    if (!wallet || !isWalletActive(wallet)) return { token };

    const configuration = await this.ctx.uow.read.recoveryConfigurations.findActive(wallet.id);
    if (!configuration) {
      await this.sendQuietly(email, recoveryNotConfiguredEmail());
      return { token };
    }

    const attempts = await this.ctx.uow.read.recoveryAttempts.countStartedSince(
      identity.userId,
      new Date(now.getTime() - DAY_MS),
    );
    const decision = this.ctx.risk.evaluate({
      userId: identity.userId,
      walletId: wallet.id,
      now,
      attemptsInLast24h: attempts,
      lastCompletedAt: await this.ctx.uow.read.recoveryAttempts.lastCompletedAt(identity.userId),
    });
    if (!decision.allow) {
      await this.ctx.uow.read.audit.append({
        id: createId(),
        userId: identity.userId,
        type: RECOVERY_AUDIT_EVENTS.startRejected,
        entityType: "wallet",
        entityId: wallet.id,
        data: { reason: decision.reason },
      });
      await this.sendQuietly(email, recoveryUnavailableEmail());
      return { token };
    }

    const issued = await this.ctx.uow.transaction(async (tx) => {
      let attempt = await tx.recoveryAttempts.findActiveByWallet(wallet.id);
      let created = false;
      if (!attempt) {
        attempt = await tx.recoveryAttempts.create({
          id: createId(),
          userId: identity.userId,
          walletId: wallet.id,
          configurationId: configuration.id,
          tokenHash: sessionTokenHash,
          tokenExpiresAt: new Date(now.getTime() + this.ctx.policy.tokenTtlMs),
        });
        created = attempt !== null;
        // A concurrent start won the row: take part in its attempt instead.
        attempt ??= await tx.recoveryAttempts.findActiveByWallet(wallet.id);
      }
      if (!attempt) return null;
      const last = await tx.recoveryEmailChallenges.lastIssuedAt(attempt.id);
      if (last && now.getTime() - last.getTime() < this.ctx.policy.emailResendCooldownMs)
        return null;
      const code = newEmailCode();
      const expiresAt = new Date(now.getTime() + this.ctx.policy.emailCodeTtlMs);
      await tx.recoveryEmailChallenges.create({
        id: createId(),
        attemptId: attempt.id,
        sessionTokenHash,
        codeHash: hashEmailCode(this.ctx.challengeSecret, attempt.id, code),
        expiresAt,
        maxAttempts: this.ctx.policy.emailMaxAttempts,
      });
      if (created) await audit(tx, attempt, RECOVERY_AUDIT_EVENTS.started);
      await audit(tx, attempt, RECOVERY_AUDIT_EVENTS.emailChallengeSent);
      return { code, expiresAt };
    });
    if (issued) await this.sendCode(email, issued.code, issued.expiresAt);
    return { token };
  }

  /** Sends another code for the same session token (bounded by a count and a cooldown). Same answer for any token. */
  async resend(token: unknown): Promise<void> {
    const sessionTokenHash = hashOpaqueToken(readToken(token));
    if (!(await this.stepLimiter.allow(`resend:${sessionTokenHash}`))) {
      throw new KaadaError("RECOVERY_RATE_LIMITED", "too many requests, try again later");
    }
    const now = this.ctx.now();
    const latest =
      await this.ctx.uow.read.recoveryEmailChallenges.findLatestBySessionTokenHash(
        sessionTokenHash,
      );
    if (!latest) return;
    const read = this.ctx.uow.read;
    const attempt = await read.recoveryAttempts.findById(latest.attemptId);
    if (!attempt) return;
    if (
      (await read.recoveryEmailChallenges.countForAttempt(attempt.id)) >=
        this.ctx.policy.emailMaxIssues ||
      now.getTime() - latest.createdAt.getTime() < this.ctx.policy.emailResendCooldownMs
    ) {
      return;
    }
    const email = await this.emailOf(attempt.userId);
    if (!email) return;
    const code = newEmailCode();
    const expiresAt = new Date(now.getTime() + this.ctx.policy.emailCodeTtlMs);
    await this.ctx.uow.transaction(async (tx) => {
      await tx.recoveryEmailChallenges.create({
        id: createId(),
        attemptId: attempt.id,
        sessionTokenHash,
        codeHash: hashEmailCode(this.ctx.challengeSecret, attempt.id, code),
        expiresAt,
        maxAttempts: this.ctx.policy.emailMaxAttempts,
      });
      await audit(tx, attempt, RECOVERY_AUDIT_EVENTS.emailChallengeSent, { resend: true });
    });
    await this.sendCode(email, code, expiresAt);
  }

  /**
   * Checks the emailed code. Every failure (unknown token, wrong code, expired, used, too many tries) is the SAME error, so
   * nothing here tells a caller whether an account exists. A correct code only unlocks the next step.
   */
  async verifyEmail(token: unknown, code: unknown): Promise<RecoveryStatusView> {
    const sessionTokenHash = hashOpaqueToken(readToken(token));
    if (!(await this.stepLimiter.allow(`verify:${sessionTokenHash}`))) {
      throw new KaadaError("RECOVERY_RATE_LIMITED", "too many requests, try again later");
    }
    if (typeof code !== "string" || !EMAIL_CODE_PATTERN.test(code)) throw invalidSession();
    const now = this.ctx.now();
    const read = this.ctx.uow.read;
    const latest =
      await read.recoveryEmailChallenges.findLatestBySessionTokenHash(sessionTokenHash);
    if (!latest) throw invalidSession();
    const attempt = await read.recoveryAttempts.findById(latest.attemptId);
    if (!attempt) throw invalidSession();

    const reservation = await read.recoveryEmailChallenges.reserveAttempt(latest.id, now);
    if (reservation.state !== "ADMITTED") throw invalidSession();
    const matches = sameDigest(
      reservation.challenge.codeHash,
      hashEmailCode(this.ctx.challengeSecret, attempt.id, code),
    );
    if (!matches) {
      await audit(read, attempt, RECOVERY_AUDIT_EVENTS.emailVerificationFailed);
      throw invalidSession();
    }
    // A single winner: a replay of the same correct code gets nothing.
    if (!(await read.recoveryEmailChallenges.markUsed(latest.id, now))) throw invalidSession();

    const verified = await this.ctx.uow.transaction(async (tx) => {
      const current = await tx.recoveryAttempts.findById(attempt.id);
      if (!current) return null;
      const expiry = new Date(now.getTime() + this.ctx.policy.tokenTtlMs);
      const tokenExpiresAt =
        expiry.getTime() > current.tokenExpiresAt.getTime() ? expiry : current.tokenExpiresAt;
      const moved =
        current.status === "EMAIL_PENDING"
          ? await tx.recoveryAttempts.advance({
              id: current.id,
              from: ["EMAIL_PENDING"],
              to: "EMAIL_VERIFIED",
              patch: { emailVerifiedAt: now, tokenHash: sessionTokenHash, tokenExpiresAt },
            })
          : await tx.recoveryAttempts.patch(
              current.id,
              { tokenHash: sessionTokenHash, tokenExpiresAt },
              { status: [current.status] },
            );
      if (moved) await audit(tx, moved, RECOVERY_AUDIT_EVENTS.emailVerified);
      return moved;
    });
    if (!verified) throw invalidSession();
    return this.viewOf(verified);
  }

  /** The status of the attempt a (verified) session token belongs to. */
  async status(token: unknown): Promise<RecoveryStatusView> {
    return this.viewOf(await resolveAttempt(this.ctx, token));
  }

  // ───────────────────────────────── the new root ─────────────────────────────────

  /** WebAuthn registration options for a passkey on the NEW device. Nothing is stored until the recovery completes. */
  async beginNewPasskey(token: unknown): Promise<{
    challenge: string;
    rpId: string;
    userId: string;
    userName: string;
  }> {
    const attempt = await resolveAttempt(this.ctx, token, { allow: ["EMAIL_VERIFIED"] });
    await this.requireStep(attempt);
    const challenge = randomBytes(32).toString("base64url");
    await this.ctx.uow.read.passkeys.issueChallenge({
      id: createId(),
      userId: attempt.userId,
      purpose: "REGISTRATION",
      challenge,
      expiresAt: new Date(this.ctx.now().getTime() + 5 * 60 * 1000),
    });
    return { challenge, rpId: this.ctx.rpId, userId: attempt.userId, userName: "Kaada wallet" };
  }

  /** The new device registered a passkey: verify it and propose the exact new root. */
  async proposePasskeyRoot(token: unknown, response: unknown): Promise<RootProposal> {
    const attempt = await resolveAttempt(this.ctx, token, { allow: ["EMAIL_VERIFIED"] });
    await this.requireStep(attempt);
    const reject = (message: string) => new KaadaError("CREDENTIAL_REJECTED", message);
    const challenge = challengeOf(response);
    if (!challenge) throw reject("the registration response is malformed");
    const consumed = await this.ctx.uow.read.passkeys.consumeChallenge({
      userId: attempt.userId,
      purpose: "REGISTRATION",
      challenge,
      now: this.ctx.now(),
    });
    if (!consumed) throw reject("the challenge is unknown, expired or already used");
    const verified = await this.ctx.passkeyVerifier.verifyRegistration({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.ctx.origin,
      expectedRpId: this.ctx.rpId,
    });
    if (!verified) throw reject("the registration could not be verified");
    if (await this.ctx.uow.read.passkeys.findByCredentialId(verified.credentialId)) {
      throw reject("this credential is already registered");
    }
    return this.propose(
      attempt,
      {
        kind: "PASSKEY",
        credentialId: verified.credentialId,
        publicKeyX: verified.publicKeyX,
        publicKeyY: verified.publicKeyY,
      },
      { rpId: this.ctx.rpId, tier: "UNKNOWN" },
    );
  }

  /** The one-time nonce the new native device passes to the platform when it generates its key (bound to this recovery). */
  async issueAttestationChallenge(
    token: unknown,
    platform: "ANDROID" | "IOS",
  ): Promise<IssuedAttestationChallenge> {
    if (!this.deps.deviceTiers) {
      throw new KaadaError("CREDENTIAL_REJECTED", "device attestation is not enabled");
    }
    const attempt = await resolveAttempt(this.ctx, token, { allow: ["EMAIL_VERIFIED"] });
    await this.requireStep(attempt);
    return this.deps.deviceTiers.issueChallenge({
      userId: attempt.userId,
      walletId: attempt.walletId,
      platform,
      purpose: "RECOVERY_ROOT",
    });
  }

  /** The new device generated a P-256 key: validate it and propose the exact new root. */
  async proposeDeviceRoot(token: unknown, input: DeviceRootInput): Promise<RootProposal> {
    const attempt = await resolveAttempt(this.ctx, token, { allow: ["EMAIL_VERIFIED"] });
    await this.requireStep(attempt);
    const reject = (message: string) => new KaadaError("CREDENTIAL_REJECTED", message);
    if (!HEX64.test(input.publicKeyX) || !HEX64.test(input.publicKeyY)) {
      throw reject("the public key is malformed");
    }
    const point = { x: BigInt(`0x${input.publicKeyX}`), y: BigInt(`0x${input.publicKeyY}`) };
    if (!isOnP256Curve(point)) throw reject("the public key is not a valid P-256 point");
    // The route (never the body) decides whether platform evidence may be considered; only verified evidence raises the tier.
    const { tier, outcome, reason } = await resolveDeviceTier(this.deps.deviceTiers, {
      route: input.channel === "web" ? "web" : "native",
      userId: attempt.userId,
      walletId: attempt.walletId,
      purpose: "RECOVERY_ROOT",
      point: { x: input.publicKeyX, y: input.publicKeyY },
      evidence: input.attestation,
    });
    await audit(this.ctx.uow.read, attempt, RECOVERY_AUDIT_EVENTS.deviceTierAssigned, {
      tier,
      attestation: outcome,
      ...(reason && { reason }),
    });
    return this.propose(
      attempt,
      {
        kind: "DEVICE_KEY",
        // The key id is derived from the point, so the server never accepts an id it did not derive.
        keyId: deviceKeyIdFromPoint(point),
        publicKeyX: input.publicKeyX,
        publicKeyY: input.publicKeyY,
      },
      { tier },
    );
  }

  private async propose(
    attempt: RecoveryAttempt,
    credential: RootCredentialData,
    extra: { rpId?: string; tier: DeviceSecurityTier },
  ): Promise<RootProposal> {
    const { wallet, configuration } = await this.liveContext(attempt);
    const account = wallet.address;
    const state = await this.chainState(account, configuration);
    const root = this.ctx.chain.proposeRoot({ account, credential, attemptId: attempt.id });
    await this.requireFreshInstance(wallet, account, root);

    const now = this.ctx.now();
    const deadline = String(Math.floor((now.getTime() + this.ctx.policy.proofTtlMs) / 1000));
    const typed = this.ctx.chain.typedMessage({
      account,
      root,
      nonce: state.recoveryNonce,
      deadline,
    });

    const proposed = await this.ctx.uow.transaction(async (tx) => {
      const credentialId = createId();
      await tx.walletCredentials.create({
        id: credentialId,
        userId: attempt.userId,
        walletId: wallet.id,
        kind: credential.kind,
        role: "RECOVERY",
        status: "PENDING",
        isRoot: false,
        validatorAddress: root.validator,
        validatorPurpose: root.purpose,
        deploymentSalt: root.deploymentSalt,
        credentialRef: credential.kind === "PASSKEY" ? credential.credentialId : credential.keyId,
        publicKeyX: credential.publicKeyX,
        publicKeyY: credential.publicKeyY,
        ...(extra.rpId && { rpId: extra.rpId }),
        securityTier: extra.tier,
      });
      const moved = await tx.recoveryAttempts.advance({
        id: attempt.id,
        from: ["EMAIL_VERIFIED"],
        to: "ROOT_PROPOSED",
        patch: {
          newCredentialId: credentialId,
          newRootKind: credential.kind,
          newValidator: root.validator,
          newValidatorData: root.validatorData,
          newValidatorDataHash: root.validatorDataHash,
          newHook: root.hook,
          newHookData: root.hookData,
          newHookDataHash: root.hookDataHash,
          commitmentHash: root.commitmentHash,
          recoveryNonce: state.recoveryNonce,
          proofDeadline: new Date(Number(deadline) * 1000),
          proposedAt: now,
          ...(state.rootValidator && { previousRootValidator: state.rootValidator }),
        },
      });
      if (!moved) return false;
      await audit(tx, attempt, RECOVERY_AUDIT_EVENTS.rootProposed, { kind: credential.kind });
      return true;
    });
    if (!proposed) {
      throw new KaadaError("RECOVERY_REJECTED", "this step is not available right now");
    }
    return {
      typedData: this.ctx.chain.typedData(typed),
      chainId: this.ctx.chain.chainId,
      account,
      recoveryAddress: configuration.recoveryAddress,
      root: { kind: credential.kind, validator: root.validator, rootId: root.rootId },
      deadline,
    };
  }

  // ───────────────────────────── proof, factors, initiation ─────────────────────────────

  /**
   * The two secrets the person holds, submitted together: the Recovery Code key's signature over the stored commitment, and a
   * current code from their authenticator app. Both are checked here; only if both hold, and every precondition still holds,
   * does the recovery start on chain. A wrong answer for either one is the SAME refusal, so a caller learns nothing about
   * which factor failed, and every refusal counts toward the attempt's failure budget.
   */
  async submitProof(
    token: unknown,
    recoverySignature: unknown,
    authenticatorCode: unknown,
  ): Promise<RecoveryStatusView> {
    const attempt = await resolveAttempt(this.ctx, token, { allow: ["ROOT_PROPOSED"] });
    if (!(await this.stepLimiter.allow(`proof:${attempt.id}`))) {
      throw new KaadaError("RECOVERY_RATE_LIMITED", "too many requests, try again later");
    }
    if (typeof recoverySignature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(recoverySignature)) {
      throw new KaadaError("RECOVERY_REJECTED", "the signature is malformed");
    }
    if (typeof authenticatorCode !== "string" || !TOTP_CODE_PATTERN.test(authenticatorCode)) {
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "enter the 6-digit code from your authenticator app",
      );
    }
    const now = this.ctx.now();
    if (!attempt.proofDeadline || attempt.proofDeadline.getTime() <= now.getTime()) {
      await this.ctx.uow.read.recoveryAttempts.advance({
        id: attempt.id,
        from: ["ROOT_PROPOSED"],
        to: "EXPIRED",
        patch: { terminatedBy: "SYSTEM", terminatedAt: now, failureCode: "PROOF_DEADLINE" },
      });
      throw new KaadaError("RECOVERY_REJECTED", "the signing window has closed; start again");
    }

    const { wallet, configuration } = await this.liveContext(attempt);
    const account = wallet.address;
    const root = await this.rebuildRoot(attempt, wallet);
    // The stored commitment is authoritative: what is rebuilt must equal it exactly.
    if (root.commitmentHash !== attempt.commitmentHash || root.validator !== attempt.newValidator) {
      await this.failAttempt(attempt, ["ROOT_PROPOSED"], "COMMITMENT_MISMATCH");
      throw new KaadaError("RECOVERY_REJECTED", "the proposed root changed; start again");
    }
    const state = await this.chainState(account, configuration);
    if (state.recoveryNonce !== attempt.recoveryNonce) {
      throw new KaadaError("RECOVERY_CONFLICT", "the recovery state changed; start again");
    }
    if (state.rootValidator !== (attempt.previousRootValidator ?? state.rootValidator)) {
      throw new KaadaError("RECOVERY_CONFLICT", "the wallet root changed; start again");
    }
    // The authenticator app must be set up first: a wallet without one cannot be recovered through Kaada.
    if (!(await this.ctx.totp.isEnrolled(wallet.id))) {
      throw new KaadaError(
        "RECOVERY_TOTP_REQUIRED",
        "recovery needs an authenticator app, which is not set up",
      );
    }

    // The risk policy is asked BEFORE any factor is checked or spent: a refusal here never burns the person's authenticator code.
    const decision = this.ctx.risk.evaluate({
      userId: attempt.userId,
      walletId: wallet.id,
      now,
      // This very attempt is one of the starts being counted.
      attemptsInLast24h: Math.max(
        0,
        (await this.ctx.uow.read.recoveryAttempts.countStartedSince(
          attempt.userId,
          new Date(now.getTime() - DAY_MS),
        )) - 1,
      ),
      lastCompletedAt: await this.ctx.uow.read.recoveryAttempts.lastCompletedAt(attempt.userId),
    });
    if (!decision.allow) {
      await audit(this.ctx.uow.read, attempt, RECOVERY_AUDIT_EVENTS.proofRefused, {
        reason: decision.reason,
      });
      throw new KaadaError("RECOVERY_REJECTED", "recovery cannot continue right now");
    }

    const message = this.ctx.chain.typedMessage({
      account,
      root,
      nonce: attempt.recoveryNonce ?? "0",
      deadline: String(Math.floor(attempt.proofDeadline.getTime() / 1000)),
    });
    const signer = await this.ctx.chain.recoverInitiateSigner(message, recoverySignature);
    const recoveryCodeOk =
      signer !== null && signer.toLowerCase() === configuration.recoveryAddress.toLowerCase();

    // The authenticator step is only SPENT when the Recovery Code signature is also right: a wrong Recovery Code never burns
    // the person's authenticator code, and the two failures look the same from outside.
    let totpStep: number | null = null;
    if (recoveryCodeOk) {
      try {
        totpStep = (
          await this.ctx.totp.verifyAndConsume({
            userId: attempt.userId,
            walletId: wallet.id,
            code: authenticatorCode,
          })
        ).step;
      } catch (error) {
        if (isKaadaError(error, "RECOVERY_RATE_LIMITED")) throw error;
        totpStep = null;
      }
    }
    if (!recoveryCodeOk || totpStep === null) {
      const failures = await this.ctx.uow.read.recoveryAttempts.recordProofFailure(attempt.id);
      await audit(this.ctx.uow.read, attempt, RECOVERY_AUDIT_EVENTS.proofRejected, { failures });
      if (failures >= this.ctx.policy.maxProofFailures) {
        await this.failAttempt(attempt, ["ROOT_PROPOSED"], "PROOF_FAILURES");
      }
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "the Recovery Code or the authenticator code did not match",
      );
    }

    // Exactly one process submits: the claim is one conditional update.
    const claimed = await this.ctx.uow.read.recoveryAttempts.advance({
      id: attempt.id,
      from: ["ROOT_PROPOSED"],
      to: "INITIATING",
      patch: {
        totpVerifiedAt: now,
        totpStep,
        ...(state.rootValidator && { previousRootValidator: state.rootValidator }),
      },
    });
    if (!claimed) throw new KaadaError("RECOVERY_REJECTED", "this step is not available right now");

    try {
      await this.ctx.chain.deployInstance({ account, root });
      const { txHash } = await this.ctx.chain.initiate({
        account,
        root,
        deadline: String(Math.floor(attempt.proofDeadline.getTime() / 1000)),
        recoverySignature,
      });
      return this.viewOf(await this.finishInitiationPatiently(claimed, wallet, txHash));
    } catch (error) {
      if (isKaadaError(error, "RECOVERY_RELAYER_UNAVAILABLE")) {
        // The relayer could not submit and NOTHING was sent. Safety over availability: there is no fallback and nobody else may
        // submit. The claim is released so the same proposal can be proven again once the service is back; no partial state exists.
        await audit(this.ctx.uow.read, claimed, RECOVERY_AUDIT_EVENTS.initiationFailed, {
          reason: "RELAYER_UNAVAILABLE",
        });
        await this.ctx.uow.read.recoveryAttempts.advance({
          id: claimed.id,
          from: ["INITIATING"],
          to: "ROOT_PROPOSED",
        });
        this.ctx.log("error", "recovery.relayer_unavailable", { attemptId: claimed.id });
        throw error;
      }
      await audit(this.ctx.uow.read, claimed, RECOVERY_AUDIT_EVENTS.initiationFailed);
      // The chain may have accepted it even though the call failed: read before giving up.
      const settled = await this.reconcileInitiating(claimed);
      if (settled && settled.status === "PENDING") return this.viewOf(settled);
      if (settled && settled.status === "FAILED") {
        throw new KaadaError("RECOVERY_REJECTED", "the recovery could not be started", {
          cause: error,
        });
      }
      if (isKaadaError(error, "RECOVERY_REJECTED")) {
        // A definite refusal by the chain (not an ambiguous failure): nothing was started, and nothing will be.
        await this.failAttempt(claimed, ["INITIATING"], "INITIATE_REVERTED");
        throw new KaadaError("RECOVERY_REJECTED", "the recovery could not be started", {
          cause: error,
        });
      }
      throw new KaadaError("RECOVERY_CHAIN_UNAVAILABLE", "recovery is temporarily unavailable", {
        cause: error,
      });
    }
  }

  /**
   * INITIATING -> PENDING once the chain shows the committed recovery. Also the recovery path for a crash between the
   * on-chain call and the database write: it reads the chain instead of trusting a return value.
   */
  async finishInitiation(
    attempt: RecoveryAttempt,
    wallet: Wallet & { address: string },
    txHash?: string,
  ): Promise<RecoveryAttempt> {
    const validatorState = await this.ctx.chain.validatorState(wallet.address);
    const pending = validatorState.pending;
    if (!pending || pending.commitment.toLowerCase() !== attempt.commitmentHash?.toLowerCase()) {
      throw new KaadaError(
        "RECOVERY_CHAIN_UNAVAILABLE",
        "the chain does not show the recovery yet",
      );
    }
    const now = this.ctx.now();
    const executeAfter = new Date(pending.executeAfter * 1000);
    const cancelToken = newOpaqueToken();
    const account = await this.ctx.chain.accountState(wallet.address);
    const moved = await this.ctx.uow.transaction(async (tx) => {
      const advanced = await tx.recoveryAttempts.advance({
        id: attempt.id,
        from: ["INITIATING"],
        to: "PENDING",
        patch: {
          initiatedAt: now,
          executeAfter,
          initiateTxHash: txHash ?? `0x${"0".repeat(64)}`,
          cancelTokenHash: hashOpaqueToken(cancelToken),
          ...(account.rootValidator && { previousRootValidator: account.rootValidator }),
          // The person comes back to this session while the timelock runs, and for the steps after it.
          tokenExpiresAt: new Date(
            Math.max(
              attempt.tokenExpiresAt.getTime(),
              executeAfter.getTime() + this.ctx.policy.postRecoveryTtlMs + DAY_MS,
            ),
          ),
        },
      });
      if (advanced)
        await audit(tx, advanced, RECOVERY_AUDIT_EVENTS.initiated, {
          executeAfter: executeAfter.toISOString(),
        });
      return advanced;
    });
    if (!moved) {
      // A concurrent reconcile already finished it.
      const current = await this.ctx.uow.read.recoveryAttempts.findById(attempt.id);
      if (!current) throw new KaadaError("RECOVERY_REJECTED", "this recovery no longer exists");
      return current;
    }
    // Tell every linked channel, with the link that leads to stopping it from the current root. A delivery failure never undoes the recovery.
    await this.ctx.notifier.notify(
      moved.userId,
      moved.id,
      recoveryStartedMessage({
        now,
        executeAfter,
        cancelLink: cancelUrl(this.ctx.webUrl, cancelToken),
      }),
    );
    return moved;
  }

  /**
   * The transaction is included, but a node may answer from an older block for a moment: read again (bounded) until the chain
   * shows the recovery. Only a chain that still shows nothing after the wait is treated as ambiguous.
   */
  private async finishInitiationPatiently(
    attempt: RecoveryAttempt,
    wallet: Wallet & { address: string },
    txHash: string,
  ): Promise<RecoveryAttempt> {
    const deadline = this.ctx.now().getTime() + this.ctx.policy.inclusionWaitMs;
    for (;;) {
      try {
        return await this.finishInitiation(attempt, wallet, txHash);
      } catch (error) {
        if (!isKaadaError(error, "RECOVERY_CHAIN_UNAVAILABLE")) throw error;
        if (this.ctx.now().getTime() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  /** Resolves an INITIATING attempt by reading the chain: PENDING if it is there, FAILED once the grace has passed. */
  async reconcileInitiating(attempt: RecoveryAttempt): Promise<RecoveryAttempt | null> {
    const wallet = await this.ctx.uow.read.wallets.findById(attempt.walletId);
    if (!wallet || !isWalletActive(wallet)) return null;
    try {
      return await this.finishInitiation(attempt, wallet);
    } catch (error) {
      if (!isKaadaError(error, "RECOVERY_CHAIN_UNAVAILABLE")) throw error;
    }
    if (
      this.ctx.now().getTime() - attempt.updatedAt.getTime() >
      this.ctx.policy.initiatingGraceMs
    ) {
      return this.failAttempt(attempt, ["INITIATING"], "INITIATE_NOT_FOUND");
    }
    return null;
  }

  // ───────────────────────────── cancellation by the existing root ─────────────────────────────

  /** Builds (and stores) the operation the existing root must sign to cancel. The link comes from a notification. */
  async prepareCancel(cancelToken: unknown): Promise<RootSigningRequest> {
    const attempt = await this.byCancelToken(cancelToken);
    const { wallet } = await this.walletOf(attempt);
    const state = await this.ctx.chain.accountState(wallet.address);
    if (!state.rootValidator || state.rootValidator !== attempt.previousRootValidator) {
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "the wallet root is not the one this recovery was started against",
      );
    }
    const root = await this.rootCredentialFor(wallet, state.rootValidator);
    const prepared = await this.ctx.chain.prepareRootOperation({
      account: wallet.address,
      rootValidator: state.rootValidator,
      rootKind: root.kind,
      calls: this.ctx.chain.cancelCalls(),
    });
    const stored = await this.ctx.uow.read.recoveryAttempts.patch(
      attempt.id,
      { cancelChallenge: prepared.userOpHash.toLowerCase(), cancelPrepared: prepared.operation },
      { status: ["PENDING"] },
    );
    if (!stored) throw invalidSession();
    await audit(this.ctx.uow.read, attempt, RECOVERY_AUDIT_EVENTS.cancelPrepared);
    return this.signingRequest(root, wallet.address, prepared.userOpHash);
  }

  /** The existing root signed the stored cancel operation: check it on chain, send it, settle when included. */
  async submitCancel(cancelToken: unknown, material: unknown): Promise<RecoveryStatusView> {
    const attempt = await this.byCancelToken(cancelToken);
    if (!attempt.cancelPrepared || !attempt.cancelChallenge) {
      throw new KaadaError("RECOVERY_REJECTED", "prepare the cancellation first");
    }
    const { wallet } = await this.walletOf(attempt);
    const state = await this.ctx.chain.accountState(wallet.address);
    if (!state.rootValidator || state.rootValidator !== attempt.previousRootValidator) {
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "the wallet root is not the one this recovery was started against",
      );
    }
    const root = await this.rootCredentialFor(wallet, state.rootValidator);
    const signature = this.ctx.chain.encodeRootSignature({ kind: root.kind, material });
    // The validator itself is the judge: a signature it would not accept never reaches the bundler.
    const valid = await this.ctx.chain.checkSignature({
      account: wallet.address,
      validator: state.rootValidator,
      kind: root.kind,
      hash: attempt.cancelChallenge,
      signature,
    });
    if (!valid) throw new KaadaError("CREDENTIAL_REJECTED", "the signature was not accepted");

    const { userOpHash } = await this.ctx.chain.submitOperation({
      operation: attempt.cancelPrepared,
      signature,
    });
    const stored = await this.ctx.uow.read.recoveryAttempts.patch(
      attempt.id,
      { cancelUserOpHash: userOpHash.toLowerCase() },
      { status: ["PENDING"] },
    );
    const settled = await this.settleAfterInclusion(stored ?? attempt, userOpHash);
    return this.viewOf(settled);
  }

  /** Waits (bounded) for a submitted cancel to be included, then settles; otherwise leaves it to the reconciler. */
  private async settleAfterInclusion(
    attempt: RecoveryAttempt,
    userOpHash: string,
  ): Promise<RecoveryAttempt> {
    const deadline = this.ctx.now().getTime() + this.ctx.policy.inclusionWaitMs;
    for (;;) {
      const status = await this.ctx.chain.operationStatus(userOpHash);
      if (status.state === "INCLUDED") break;
      if (this.ctx.now().getTime() >= deadline) return attempt;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return (await this.settleWhenGone(attempt.id)) ?? attempt;
  }

  /**
   * A cancel was included, but a node may still answer from an older block for a moment: read again (bounded) until the
   * chain no longer shows the recovery, so the attempt is recorded as ended and not left PENDING.
   * Anything still unresolved is finished by the sweeper.
   */
  private async settleWhenGone(attemptId: string): Promise<RecoveryAttempt | null> {
    const deadline = this.ctx.now().getTime() + this.ctx.policy.inclusionWaitMs;
    for (;;) {
      const attempt = await this.reconcilePending(attemptId);
      if (!attempt || attempt.status !== "PENDING") return attempt;
      if (this.ctx.now().getTime() >= deadline) return attempt;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /**
   * Compares a PENDING attempt with the chain. If the recovery is gone and the root did not change, it was cancelled: only
   * the account itself (a root-signed operation) can cancel or uninstall the validator, so the chain alone says who ended it.
   * Safe to call any number of times, from any process.
   */
  async reconcilePending(attemptId: string): Promise<RecoveryAttempt | null> {
    const attempt = await this.ctx.uow.read.recoveryAttempts.findById(attemptId);
    if (!attempt || (attempt.status !== "PENDING" && attempt.status !== "FINALIZING"))
      return attempt;
    const wallet = await this.ctx.uow.read.wallets.findById(attempt.walletId);
    if (!wallet?.address) return attempt;
    const validatorState = await this.ctx.chain.validatorState(wallet.address);
    if (validatorState.pending) return attempt;
    const account = await this.ctx.chain.accountState(wallet.address);
    if (account.rootValidator && account.rootValidator === attempt.newValidator) return attempt; // finalized elsewhere
    const now = this.ctx.now();
    const moved = await this.ctx.uow.transaction(async (tx) => {
      const advanced = await tx.recoveryAttempts.advance({
        id: attempt.id,
        from: ["PENDING", "FINALIZING"],
        to: "CANCELLED",
        patch: { terminatedBy: "ROOT", terminatedAt: now },
      });
      if (advanced) await audit(tx, advanced, RECOVERY_AUDIT_EVENTS.cancelled);
      return advanced;
    });
    if (moved) {
      await this.ctx.notifier.notify(moved.userId, moved.id, recoveryCancelledMessage());
    }
    return moved ?? (await this.ctx.uow.read.recoveryAttempts.findById(attemptId));
  }

  // ───────────────────────────────────── helpers ─────────────────────────────────────

  async failAttempt(
    attempt: RecoveryAttempt,
    from: RecoveryAttempt["status"][],
    code: string,
  ): Promise<RecoveryAttempt | null> {
    const moved = await this.ctx.uow.read.recoveryAttempts.advance({
      id: attempt.id,
      from,
      to: "FAILED",
      patch: { terminatedBy: "SYSTEM", terminatedAt: this.ctx.now(), failureCode: code },
      clear: ["lease"],
    });
    if (moved)
      await audit(this.ctx.uow.read, moved, RECOVERY_AUDIT_EVENTS.initiationFailed, { code });
    return moved;
  }

  private async requireStep(attempt: RecoveryAttempt): Promise<void> {
    if (!(await this.stepLimiter.allow(`step:${attempt.id}`))) {
      throw new KaadaError("RECOVERY_RATE_LIMITED", "too many requests, try again later");
    }
  }

  private async viewOf(attempt: RecoveryAttempt): Promise<RecoveryStatusView> {
    const wallet = await this.ctx.uow.read.wallets.findById(attempt.walletId);
    const configuration = attempt.configurationId
      ? await this.ctx.uow.read.recoveryConfigurations.findById(attempt.configurationId)
      : null;
    return statusView(this.ctx, attempt, wallet, configuration?.recoveryAddress);
  }

  private async byCancelToken(token: unknown): Promise<RecoveryAttempt> {
    const attempt = await this.ctx.uow.read.recoveryAttempts.findByCancelTokenHash(
      hashOpaqueToken(readToken(token)),
    );
    if (!attempt || attempt.status !== "PENDING") throw invalidSession();
    return attempt;
  }

  private async walletOf(
    attempt: RecoveryAttempt,
  ): Promise<{ wallet: Wallet & { address: string } }> {
    const wallet = await this.ctx.uow.read.wallets.findById(attempt.walletId);
    if (!wallet || !isWalletActive(wallet)) {
      throw new KaadaError("WALLET_NOT_ACTIVE", "the wallet is not active");
    }
    return { wallet };
  }

  /** The wallet and the ACTIVE configuration this attempt relies on; both must still hold. */
  private async liveContext(
    attempt: RecoveryAttempt,
  ): Promise<{ wallet: Wallet & { address: string }; configuration: RecoveryConfiguration }> {
    const { wallet } = await this.walletOf(attempt);
    const configuration = await this.ctx.uow.read.recoveryConfigurations.findActive(wallet.id);
    if (
      !configuration ||
      (attempt.configurationId && configuration.id !== attempt.configurationId)
    ) {
      throw new KaadaError("RECOVERY_NOT_CONFIGURED", "recovery is not set up for this wallet");
    }
    return { wallet, configuration };
  }

  /** The chain must agree with the stored configuration and show no recovery already pending. */
  private async chainState(account: string, configuration: RecoveryConfiguration) {
    const [validator, accountState] = await Promise.all([
      this.ctx.chain.validatorState(account),
      this.ctx.chain.accountState(account),
    ]);
    if (
      !validator.initialized ||
      validator.recoveryKey?.toLowerCase() !== configuration.recoveryAddress.toLowerCase()
    ) {
      throw new KaadaError(
        "RECOVERY_NOT_CONFIGURED",
        "recovery is not armed on chain for this wallet",
      );
    }
    if (validator.pending) {
      throw new KaadaError("RECOVERY_CONFLICT", "a recovery is already pending for this wallet");
    }
    if (!accountState.deployed)
      throw new KaadaError("RECOVERY_NOT_CONFIGURED", "the wallet is not deployed");
    return { recoveryNonce: validator.recoveryNonce, rootValidator: accountState.rootValidator };
  }

  /** A validator instance is used at most once, ever: not recorded for the wallet, and not initialized on chain. */
  private async requireFreshInstance(
    wallet: Wallet,
    account: string,
    root: ProposedRoot,
  ): Promise<void> {
    if (await this.ctx.uow.read.walletCredentials.validatorEverUsed(wallet.id, root.validator)) {
      throw new KaadaError("RECOVERY_REJECTED", "this validator instance was already used");
    }
    if ((await this.ctx.chain.instanceStatus({ account, root })) === "INITIALIZED_FOR_ACCOUNT") {
      throw new KaadaError("RECOVERY_REJECTED", "this validator instance was already used");
    }
  }

  /** The proposed root rebuilt from the stored PUBLIC credential data (never from a field a caller can set). */
  async rebuildRoot(
    attempt: RecoveryAttempt,
    wallet: Wallet & { address: string },
  ): Promise<ProposedRoot> {
    if (!attempt.newCredentialId) throw new KaadaError("RECOVERY_REJECTED", "no root was proposed");
    const credential = await this.ctx.uow.read.walletCredentials.findById(attempt.newCredentialId);
    if (!credential) throw new KaadaError("RECOVERY_REJECTED", "no root was proposed");
    return this.ctx.chain.proposeRoot({
      account: wallet.address,
      credential: toRootData(credential),
      attemptId: attempt.id,
    });
  }

  /** The WalletCredential of the current root, recorded from the chain and the user's passkeys for legacy wallets. */
  async rootCredentialFor(
    wallet: Wallet & { address: string },
    rootValidator: string,
  ): Promise<WalletCredential> {
    return ensureRootCredential(this.ctx.uow.read, wallet, rootValidator);
  }

  signingRequest(root: WalletCredential, account: string, challenge: string): RootSigningRequest {
    const hash = challenge.toLowerCase();
    return {
      challenge: hash,
      rootKind: root.kind,
      chainId: this.ctx.chain.chainId,
      ...(root.kind === "PASSKEY" && {
        passkey: {
          challenge: Buffer.from(hash.slice(2), "hex").toString("base64url"),
          rpId: this.ctx.rpId,
          userVerification: "required" as const,
        },
      }),
      ...(root.kind === "DEVICE_KEY" && {
        device: {
          chainId: this.ctx.chain.chainId,
          validator: root.validatorAddress,
          account,
          keyId: root.credentialRef,
          payload: deviceKeyPayload({
            chainId: this.ctx.chain.chainId,
            validator: root.validatorAddress as `0x${string}`,
            account: account as `0x${string}`,
            keyId: root.credentialRef as `0x${string}`,
            userOpHash: hash as `0x${string}`,
          }),
        },
      }),
    };
  }

  private async emailOf(userId: string): Promise<string | null> {
    const identities = await this.ctx.uow.read.identities.listForUser(userId);
    return identities.find((identity) => identity.type === "EMAIL")?.externalId ?? null;
  }

  private async sendCode(email: string, code: string, expiresAt: Date): Promise<void> {
    await this.sendQuietly(email, challengeEmail(code, expiresAt));
  }

  private async sendQuietly(
    email: string,
    message: { subject: string; text: string },
  ): Promise<void> {
    try {
      await this.ctx.email.send({ to: email, subject: message.subject, text: message.text });
    } catch {
      // Never logged with the body (it may carry a code); the person simply asks again.
      this.ctx.log("warn", "recovery.email_delivery_failed", {});
    }
  }
}

export function toRootData(credential: WalletCredential): RootCredentialData {
  return credential.kind === "PASSKEY"
    ? {
        kind: "PASSKEY",
        credentialId: credential.credentialRef,
        publicKeyX: credential.publicKeyX,
        publicKeyY: credential.publicKeyY,
      }
    : {
        kind: "DEVICE_KEY",
        keyId: credential.credentialRef,
        publicKeyX: credential.publicKeyX,
        publicKeyY: credential.publicKeyY,
      };
}

/**
 * The credential row of the account current root. A wallet created before credential tracking has none: it is recorded
 * from the chain (the root validator) and the user's oldest active passkey, which is how those wallets were derived.
 */
export async function ensureRootCredential(
  repositories: Pick<RecoveryRepositories, "walletCredentials" | "passkeys">,
  wallet: Wallet,
  rootValidator: string,
): Promise<WalletCredential> {
  const existing = await repositories.walletCredentials.findRoot(wallet.id);
  if (existing) {
    if (existing.validatorAddress !== rootValidator.toLowerCase()) {
      throw new KaadaError("RECOVERY_REJECTED", "the recorded root does not match the chain");
    }
    return existing;
  }
  const [passkey] = await repositories.passkeys.listActiveForUser(wallet.userId);
  if (!passkey)
    throw new KaadaError("ROOT_CREDENTIAL_REQUIRED", "no root credential is known for this wallet");
  return repositories.walletCredentials.create({
    id: createId(),
    userId: wallet.userId,
    walletId: wallet.id,
    kind: "PASSKEY",
    role: "PRIMARY",
    status: "ACTIVE",
    isRoot: true,
    validatorAddress: rootValidator.toLowerCase(),
    validatorPurpose: 0,
    deploymentSalt: `0x${"0".repeat(64)}`,
    credentialRef: passkey.credentialId,
    publicKeyX: passkey.publicKeyX,
    publicKeyY: passkey.publicKeyY,
    rpId: passkey.rpId,
    passkeyCredentialId: passkey.id,
    securityTier: "UNKNOWN",
  });
}

export { isHash };
