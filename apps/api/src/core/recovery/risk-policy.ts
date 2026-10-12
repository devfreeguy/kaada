import type { RecoveryRiskDecision, RecoveryRiskInput, RecoveryRiskPolicy } from "@kaada/domain";

/**
 * The default gate in front of a recovery: a cap on starts per day and a quiet period after a completed recovery (a
 * fresh recovery right after one is exactly what an attacker holding the new device would try). It is a pure function so
 * a richer, signal-based policy can replace it without touching the flow.
 */
export class DefaultRecoveryRiskPolicy implements RecoveryRiskPolicy {
  constructor(
    private readonly limits: { maxStartsPerDay: number; cooldownAfterCompletionMs: number },
  ) {}

  evaluate(input: RecoveryRiskInput): RecoveryRiskDecision {
    if (input.attemptsInLast24h >= this.limits.maxStartsPerDay) {
      return { allow: false, reason: "TOO_MANY_ATTEMPTS" };
    }
    if (
      input.lastCompletedAt &&
      input.now.getTime() - input.lastCompletedAt.getTime() < this.limits.cooldownAfterCompletionMs
    ) {
      return { allow: false, reason: "COOLDOWN_AFTER_RECOVERY" };
    }
    return { allow: true };
  }
}
