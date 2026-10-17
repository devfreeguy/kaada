import { KaadaError, RECOVERY_AUDIT_EVENTS, createId } from "@kaada/domain";
import type { AuditRepository, RecoveryTotp, RecoveryTotpRepository } from "@kaada/domain";

import type { RateLimit } from "../authorization/rate-limiter.js";
import { RateLimiter } from "../authorization/rate-limiter.js";
import type { SecretCipher } from "../execution/ports.js";
import { matchTotp, newTotpSecret, otpauthUri } from "./totp.js";

/** What the person scans or types into their authenticator app. Returned once, at the start of enrolment. */
export interface TotpEnrolment {
  /** `otpauth://totp/...`: the QR code content. */
  otpauthUri: string;
  /** The same secret in base32, for manual entry. */
  secret: string;
}

export interface RecoveryTotpDeps {
  totps: RecoveryTotpRepository;
  audit: Pick<AuditRepository, "append">;
  /** A DEDICATED key (RECOVERY_TOTP_SECRET_KEY): never the PIN pepper or the execution key. */
  cipher: SecretCipher;
  now: () => Date;
  issuer?: string;
  /** Guess budget per wallet, shared by enrolment and recovery. Redis-backed in production. */
  limiter?: RateLimit;
}

/** The secret is bound to its record: a ciphertext copied to another wallet or row does not decrypt. */
const cipherContext = (totp: Pick<RecoveryTotp, "id" | "walletId">) =>
  `recovery-totp:${totp.walletId}:${totp.id}`;

const rejected = () =>
  new KaadaError("RECOVERY_REJECTED", "that code did not work; check your authenticator app");

/**
 * The authenticator-app factor. It owns the secret's whole life: generated here, encrypted at rest, shown once, verified with
 * a replay guard, and disabled when a recovery spends it. It never logs or audits a secret or a code.
 */
export class RecoveryTotpService {
  private readonly limiter: RateLimit;
  private readonly issuer: string;

  constructor(private readonly deps: RecoveryTotpDeps) {
    this.limiter = deps.limiter ?? new RateLimiter(10, 10 * 60 * 1000, () => deps.now().getTime());
    this.issuer = deps.issuer ?? "Kaada";
  }

  /** Whether the wallet has a completed enrolment. */
  async isEnrolled(walletId: string): Promise<boolean> {
    return (await this.deps.totps.findActive(walletId)) !== null;
  }

  /**
   * Generates a secret and stores it ENCRYPTED as a pending enrolment. It protects nothing until a valid code is entered
   * (`confirm`). Starting again replaces an unconfirmed enrolment; an already completed one is refused.
   */
  async begin(input: {
    userId: string;
    walletId: string;
    accountName: string;
  }): Promise<TotpEnrolment> {
    const secret = newTotpSecret();
    const id = createId();
    const { ciphertext, keyVersion } = this.deps.cipher.encrypt(
      secret,
      cipherContext({ id, walletId: input.walletId }),
    );
    const created = await this.deps.totps.createPending({
      id,
      userId: input.userId,
      walletId: input.walletId,
      encryptedSecret: ciphertext,
      keyVersion,
    });
    if (!created) {
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "an authenticator app is already set up for this wallet",
      );
    }
    await this.audit(input.userId, RECOVERY_AUDIT_EVENTS.totpEnrolmentStarted, created.id);
    return {
      secret,
      otpauthUri: otpauthUri({ secret, issuer: this.issuer, account: input.accountName }),
    };
  }

  /** Enrolment is complete only when one valid 6-digit code from the app verifies against the pending secret. */
  async confirm(input: { userId: string; walletId: string; code: unknown }): Promise<void> {
    await this.admit(input.walletId);
    const pending = await this.deps.totps.findPending(input.walletId);
    if (!pending || pending.userId !== input.userId) throw rejected();
    const step = this.matchStep(pending, input.code);
    if (step === null) {
      await this.audit(input.userId, RECOVERY_AUDIT_EVENTS.totpEnrolmentRejected, pending.id);
      throw rejected();
    }
    const active = await this.deps.totps.activate({
      id: pending.id,
      step,
      at: this.deps.now(),
    });
    if (!active) throw rejected();
    await this.audit(input.userId, RECOVERY_AUDIT_EVENTS.totpEnabled, active.id);
  }

  /**
   * The check in front of a recovery: the code must match the wallet's ACTIVE secret AND its time step must be new. The step
   * is spent in the same call, so the same code can never be used for a second recovery action. Every refusal is the same
   * error, so a caller learns nothing about which part failed.
   */
  async verifyAndConsume(input: {
    userId: string;
    walletId: string;
    code: unknown;
  }): Promise<{ step: number }> {
    await this.admit(input.walletId);
    const active = await this.deps.totps.findActive(input.walletId);
    if (!active || active.userId !== input.userId) {
      throw new KaadaError("RECOVERY_TOTP_REQUIRED", "set up an authenticator app first");
    }
    const step = this.matchStep(active, input.code);
    if (step === null) {
      await this.audit(input.userId, RECOVERY_AUDIT_EVENTS.totpRejected, active.id);
      throw rejected();
    }
    if (!(await this.deps.totps.consumeStep({ id: active.id, step }))) {
      await this.audit(input.userId, RECOVERY_AUDIT_EVENTS.totpReplayRejected, active.id);
      throw rejected();
    }
    await this.audit(input.userId, RECOVERY_AUDIT_EVENTS.totpVerified, active.id);
    return { step };
  }

  /** Retires the wallet's authenticator enrolment (a recovery spent it; the person must enrol again). */
  async disable(input: { userId: string; walletId: string }): Promise<void> {
    const count = await this.deps.totps.disableForWallet(input.walletId, this.deps.now());
    if (count > 0) {
      await this.deps.audit.append({
        id: createId(),
        userId: input.userId,
        type: RECOVERY_AUDIT_EVENTS.totpDisabled,
        entityType: "wallet",
        entityId: input.walletId,
      });
    }
  }

  private async admit(walletId: string): Promise<void> {
    if (!(await this.limiter.allow(`totp:${walletId}`))) {
      throw new KaadaError("RECOVERY_RATE_LIMITED", "too many requests, try again later");
    }
  }

  private async audit(userId: string, type: string, entityId: string): Promise<void> {
    await this.deps.audit.append({
      id: createId(),
      userId,
      type,
      entityType: "recovery_totp",
      entityId,
    });
  }

  /** The matching time step, or null for a wrong, malformed or undecryptable code (one indistinguishable outcome). */
  private matchStep(totp: RecoveryTotp, code: unknown): number | null {
    if (typeof code !== "string") return null;
    try {
      const secret = this.deps.cipher.decrypt(totp.encryptedSecret, cipherContext(totp));
      return matchTotp(secret, code, this.deps.now().getTime());
    } catch {
      return null;
    }
  }
}
