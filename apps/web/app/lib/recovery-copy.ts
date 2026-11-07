/*
 * The words a person is given about recovery, in one place so setup, the confirmation step and the recovery page never drift
 * apart. Plain language: no "TOTP", no "cryptographic". The same text is in docs/recovery-orchestration.md.
 */

export const RECOVERY_NEEDS_TITLE = "To recover your Kaada wallet, you'll need all three:";
export const RECOVERY_NEEDS = [
  "your recovery email",
  "your Recovery Code",
  "access to your authenticator app",
] as const;
/** How long an emailed code works: the recovery policy's `emailCodeTtlMs` (10 minutes). Said the same on every screen. */
export const EMAIL_CODE_MINUTES = 10;
export const RECOVERY_LOSS_WARNING =
  "If you lose your Recovery Code or your authenticator app, Kaada cannot restore your wallet.";

/**
 * What the waiting screen says, by the server's step. Only a real safety delay is described as one: submitting, finishing and
 * waiting for a payment are different situations and each says what is actually happening.
 */
export const RECOVERY_WAITING = {
  WAIT: {
    title: "Recovery in progress",
    description:
      "This delay protects you. The owner of your current device can stop it from the email we sent. You can leave and come back on this device.",
    countdown: "Your wallet moves to this device in about",
    over: "The delay is over. Finishing recovery…",
    pending: "Working…",
  },
  SUBMITTING: { title: "Starting recovery", description: "Working…" },
  FINALIZING: { title: "Finishing recovery", description: "Moving your wallet to this device…" },
  /** The server holds recovery back while a payment from the old device is still being processed (PAYMENT_IN_FLIGHT). */
  WAITING_FOR_PAYMENT: {
    title: "Waiting for a payment to finish",
    description:
      "A payment is still being processed. Recovery continues once it finishes. You don't need to do anything.",
  },
} as const;

/** The step that confirms the new sign-in method on this device, by what it is. */
export const RECOVERY_PROOF = {
  PASSKEY: { title: "Confirm your new passkey", action: "Use passkey" },
  DEVICE_KEY: { title: "Confirm this device", action: "Continue on this device" },
} as const;

/** Group a base32 secret in fours for reading aloud or typing: JBSW Y3DP EHPK 3PXP. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
