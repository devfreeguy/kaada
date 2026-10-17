import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RECOVERY_ATTEMPT_STATUSES,
  RECOVERY_TERMINAL_STATUSES,
  RECOVERY_TRANSITIONS,
  canTransitionRecovery,
  isRecoveryAttemptActive,
} from "./index.js";

test("every status has a transition entry and terminal statuses have none", () => {
  for (const status of RECOVERY_ATTEMPT_STATUSES) {
    assert.ok(status in RECOVERY_TRANSITIONS, status);
    const terminal = (RECOVERY_TERMINAL_STATUSES as readonly string[]).includes(status);
    assert.equal(RECOVERY_TRANSITIONS[status].length === 0, terminal, status);
  }
  for (const terminal of RECOVERY_TERMINAL_STATUSES) {
    assert.equal(isRecoveryAttemptActive(terminal), false);
    for (const next of RECOVERY_ATTEMPT_STATUSES)
      assert.equal(canTransitionRecovery(terminal, next), false);
  }
});

test("only the documented forward path exists; nothing skips the chain or goes back", () => {
  const path = [
    "EMAIL_PENDING",
    "EMAIL_VERIFIED",
    "ROOT_PROPOSED",
    "INITIATING",
    "PENDING",
    "FINALIZING",
    "ROOT_CHANGED",
    "COMPLETED",
  ] as const;
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransitionRecovery(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`);
  }
  // nothing leaps over a stage
  assert.equal(canTransitionRecovery("EMAIL_PENDING", "PENDING"), false);
  assert.equal(canTransitionRecovery("EMAIL_VERIFIED", "INITIATING"), false);
  assert.equal(canTransitionRecovery("ROOT_PROPOSED", "PENDING"), false);
  assert.equal(canTransitionRecovery("PENDING", "ROOT_CHANGED"), false);
  assert.equal(canTransitionRecovery("PENDING", "COMPLETED"), false);
  // email alone can never reach the chain stages
  for (const chainStage of [
    "INITIATING",
    "PENDING",
    "FINALIZING",
    "ROOT_CHANGED",
    "COMPLETED",
  ] as const) {
    assert.equal(canTransitionRecovery("EMAIL_VERIFIED", chainStage), false, chainStage);
  }
  // no way back
  assert.equal(canTransitionRecovery("PENDING", "ROOT_PROPOSED"), false);
  assert.equal(canTransitionRecovery("ROOT_CHANGED", "FINALIZING"), false);
});

test("an on-chain pending recovery can be cancelled by the root, but a finished one cannot; there is no veto", () => {
  for (const exit of ["CANCELLED", "FAILED"] as const) {
    assert.ok(canTransitionRecovery("PENDING", exit));
  }
  for (const stage of ["ROOT_CHANGED", "COMPLETED"] as const) {
    assert.equal(canTransitionRecovery(stage, "CANCELLED"), false);
  }
  assert.equal((RECOVERY_ATTEMPT_STATUSES as readonly string[]).includes("VETOED"), false);
  // a deferred finalization goes back to PENDING (e.g. an in-flight payment); a crashed lease can be reclaimed
  assert.ok(canTransitionRecovery("FINALIZING", "PENDING"));
  assert.ok(canTransitionRecovery("FINALIZING", "FINALIZING"));
});

test("a claim released because the relayer was unreachable goes back to ROOT_PROPOSED, and nowhere else is a way back", () => {
  assert.ok(canTransitionRecovery("INITIATING", "ROOT_PROPOSED"));
  for (const later of ["PENDING", "FINALIZING", "ROOT_CHANGED", "COMPLETED"] as const) {
    assert.equal(canTransitionRecovery(later, "ROOT_PROPOSED"), false, later);
    assert.equal(canTransitionRecovery(later, "INITIATING"), false, later);
  }
});
