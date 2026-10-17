/*
 * The words a person is given about recovery, in one place so setup, the confirmation step and the recovery page never drift
 * apart. Plain language: no "TOTP", no "cryptographic". The same text is in docs/recovery-orchestration.md.
 */

export const RECOVERY_NEEDS_TITLE = "To recover your Kaada wallet, you'll need both:";
export const RECOVERY_NEEDS = ["your Recovery Code", "access to your authenticator app"] as const;
export const RECOVERY_LOSS_WARNING =
  "If you lose both recovery methods, Kaada cannot restore your wallet.";

/** Group a base32 secret in fours for reading aloud or typing: JBSW Y3DP EHPK 3PXP. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
