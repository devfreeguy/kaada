import type { UserNotificationKind } from "@kaada/domain";

/**
 * Where a person is on the way to being able to use Kaada, derived ONLY from what the backend knows (a wallet row, a PIN record,
 * a recovery configuration). Chat text never moves it: typing "done" proves nothing, so the answer to "done" is a fresh read of
 * this state.
 */
export const ONBOARDING_STEPS = ["WALLET", "PIN", "RECOVERY", "COMPLETE"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingFacts {
  /** An ACTIVE wallet with an address exists. */
  walletReady: boolean;
  /** Public address of that wallet. Never a secret. */
  walletAddress?: string;
  pinConfigured: boolean;
  /**
   * Whether the wallet has ever received funds. Until it has, nothing is at risk and the wallet may not even exist on chain yet, so
   * recovery is neither asked for nor counted against onboarding.
   */
  walletFunded: boolean;
  /** Whether the wallet's recovery is armed; null when this deployment has no recovery, so the step cannot apply. */
  recoveryConfigured: boolean | null;
}

export interface OnboardingPolicy {
  /**
   * Whether arming recovery must happen before onboarding counts as complete, once the wallet has received its first funds (see
   * SETTINGS.onboarding). Before that nobody is asked.
   */
  requireRecovery: boolean;
}

export interface OnboardingState {
  step: OnboardingStep;
  facts: OnboardingFacts;
}

export function deriveOnboarding(
  facts: OnboardingFacts,
  policy: OnboardingPolicy,
): OnboardingState {
  if (!facts.walletReady) return { step: "WALLET", facts };
  if (!facts.pinConfigured) return { step: "PIN", facts };
  if (policy.requireRecovery && facts.walletFunded && facts.recoveryConfigured === false)
    return { step: "RECOVERY", facts };
  return { step: "COMPLETE", facts };
}

/** Reads the authoritative facts for a user. Implemented over the repositories in the Nest glue; read only. */
export interface OnboardingStateReader {
  read(userId: string): Promise<OnboardingFacts>;
}

/** Milestones that tell a person something. Order is progress: a later one supersedes the earlier ones. */
export const ANNOUNCED_MILESTONES = [
  "WALLET_READY",
  "PIN_CREATED",
  "RECOVERY_CONFIGURED",
  "ONBOARDING_COMPLETED",
] as const satisfies readonly UserNotificationKind[];

export function milestoneRank(kind: UserNotificationKind): number {
  return (ANNOUNCED_MILESTONES as readonly string[]).indexOf(kind);
}

/** Every milestone the state has reached, in order. */
export function reachedMilestones(state: OnboardingState): UserNotificationKind[] {
  const reached: UserNotificationKind[] = [];
  if (state.facts.walletReady) reached.push("WALLET_READY");
  if (state.facts.pinConfigured) reached.push("PIN_CREATED");
  if (state.facts.recoveryConfigured === true) reached.push("RECOVERY_CONFIGURED");
  if (state.step === "COMPLETE") reached.push("ONBOARDING_COMPLETED");
  return reached;
}
