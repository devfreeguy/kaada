import { KaadaError, RECOVERY_AUDIT_EVENTS, createId } from "@kaada/domain";

import type { RecoveryContext } from "./context.js";
import {
  EMAIL_CODE_PATTERN,
  hashEmailCode,
  newEmailCode,
  normalizeEmail,
  sameDigest,
} from "./email-code.js";

/** How many codes one person may be sent per hour (across every address they try). */
const MAX_SENDS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

/** The address in a form that identifies it without exposing it: "j***@gmail.com". */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

export interface EmailStatus {
  registered: boolean;
  /** Masked, only when registered. */
  masked?: string;
}

/**
 * The email address a person recovers their account with. Recovery starts from an email (see RecoveryFlow.start), so a person with
 * no verified address cannot recover at all: this is the step that makes recovery possible.
 *
 *  - `begin` sends a 6-digit code to the address. Nothing is stored about the address but a pending verification.
 *  - `confirm` checks the code (a limited number of guesses, in one conditional update) and only then makes the address the
 *    person's EMAIL identity.
 *
 * An address that already belongs to another account is never confirmed, and the response is the same as for a free one, so this
 * page cannot be used to find out who has an account. A person who already has an address cannot change it here: that would let
 * whoever holds a setup link redirect recovery, so a change needs its own, stronger flow.
 */
export class RecoveryEmailService {
  constructor(private readonly ctx: RecoveryContext) {}

  async status(userId: string): Promise<EmailStatus> {
    const current = await this.current(userId);
    return current ? { registered: true, masked: maskEmail(current) } : { registered: false };
  }

  async begin(userId: string, input: unknown): Promise<void> {
    const email = normalizeEmail(input);
    if (!email) throw new KaadaError("RECOVERY_REJECTED", "enter a valid email address");
    if (await this.current(userId)) {
      throw new KaadaError("RECOVERY_CONFLICT", "this account already has a recovery email");
    }

    const read = this.ctx.uow.read;
    const now = this.ctx.now();
    if (
      (await read.emailVerifications.countSince(userId, new Date(now.getTime() - HOUR_MS))) >=
      MAX_SENDS_PER_HOUR
    ) {
      this.ctx.log("warn", "recovery.email_send_limited", { userId });
      throw new KaadaError("RECOVERY_RATE_LIMITED", "too many codes requested, try again later");
    }
    const latest = await read.emailVerifications.findLatest(userId);
    if (
      latest &&
      now.getTime() - latest.createdAt.getTime() < this.ctx.policy.emailResendCooldownMs
    ) {
      throw new KaadaError("RECOVERY_RATE_LIMITED", "wait a moment before asking for another code");
    }

    // The same answer whether or not the address is free: this form is not an oracle for who has an account.
    const owner = await read.identities.findByExternalId("EMAIL", email);
    if (owner && owner.userId !== userId) {
      this.ctx.log("info", "recovery.email_in_use", { userId });
      return;
    }

    const id = createId();
    const code = newEmailCode();
    await read.emailVerifications.create({
      id,
      userId,
      email,
      codeHash: hashEmailCode(this.ctx.challengeSecret, id, code),
      expiresAt: new Date(now.getTime() + this.ctx.policy.emailCodeTtlMs),
      maxAttempts: this.ctx.policy.emailMaxAttempts,
    });
    try {
      await this.ctx.email.send({
        to: email,
        subject: "Your Kaada verification code",
        text: `Your Kaada verification code is ${code}. It expires in ${String(Math.round(this.ctx.policy.emailCodeTtlMs / 60_000))} minutes. If you did not ask for it, ignore this email.`,
      });
    } catch (error) {
      // The person is told it could not be sent; the log says why (never the code).
      this.ctx.log("error", "recovery.email_send_failed", {
        userId,
        reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      throw new KaadaError("RECOVERY_BLOCKED", "the email could not be sent right now");
    }
  }

  async confirm(userId: string, code: unknown): Promise<{ masked: string }> {
    if (typeof code !== "string" || !EMAIL_CODE_PATTERN.test(code)) {
      throw new KaadaError("RECOVERY_REJECTED", "enter the 6-digit code from your email");
    }
    const read = this.ctx.uow.read;
    const latest = await read.emailVerifications.findLatest(userId);
    if (!latest) throw new KaadaError("RECOVERY_REJECTED", "that code is not right");

    const attempt = await read.emailVerifications.reserveAttempt(latest.id, this.ctx.now());
    if (attempt.state !== "ADMITTED") {
      throw new KaadaError("RECOVERY_REJECTED", "that code is no longer valid, ask for a new one");
    }
    const expected = hashEmailCode(this.ctx.challengeSecret, attempt.verification.id, code);
    if (!sameDigest(expected, attempt.verification.codeHash)) {
      throw new KaadaError("RECOVERY_REJECTED", "that code is not right");
    }

    const { email } = attempt.verification;
    await this.ctx.uow.transaction(async (tx) => {
      if (!(await tx.emailVerifications.markUsed(attempt.verification.id, this.ctx.now()))) {
        throw new KaadaError("RECOVERY_REJECTED", "that code was already used");
      }
      // Re-checked inside the transaction: the address may have been taken, or the person may have set one, meanwhile.
      const owner = await tx.identities.findByExternalId("EMAIL", email);
      if (owner) throw new KaadaError("RECOVERY_REJECTED", "that address can't be used");
      if ((await tx.identities.listForUser(userId)).some((identity) => identity.type === "EMAIL")) {
        throw new KaadaError("RECOVERY_CONFLICT", "this account already has a recovery email");
      }
      await tx.identities.add({ id: createId(), userId, type: "EMAIL", externalId: email });
      await tx.audit.append({
        id: createId(),
        userId,
        type: RECOVERY_AUDIT_EVENTS.recoveryEmailRegistered,
        entityType: "identity",
        entityId: userId,
      });
    });
    return { masked: maskEmail(email) };
  }

  private async current(userId: string): Promise<string | null> {
    const identities = await this.ctx.uow.read.identities.listForUser(userId);
    return identities.find((identity) => identity.type === "EMAIL")?.externalId ?? null;
  }
}
