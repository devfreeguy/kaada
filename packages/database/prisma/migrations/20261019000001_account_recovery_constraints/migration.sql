-- Account recovery constraints (hand-written). The database refuses states the recovery design forbids: two roots, a
-- validator instance recorded twice, two live recovery attempts for one wallet, a chain stage without its email
-- verification or its committed root, a stored token that is not a SHA-256 digest.

-- ── WalletCredential ─────────────────────────────────────────────────────────────────────────────
-- A validator instance belongs to ONE credential of a wallet, forever: reusing an instance silently keeps the old key.
CREATE UNIQUE INDEX "WalletCredential_validator_once_per_wallet"
  ON "WalletCredential" ("walletId", "validatorAddress");
-- At most one root per wallet.
CREATE UNIQUE INDEX "WalletCredential_one_root_per_wallet"
  ON "WalletCredential" ("walletId") WHERE "isRoot" AND "status" = 'ACTIVE';
ALTER TABLE "WalletCredential" ADD CONSTRAINT "WalletCredential_root_is_active" CHECK (
  NOT "isRoot" OR "status" = 'ACTIVE'
);
ALTER TABLE "WalletCredential" ADD CONSTRAINT "WalletCredential_wellformed" CHECK (
  "validatorAddress" ~ '^0x[0-9a-f]{40}$'
  AND "deploymentSalt" ~ '^0x[0-9a-f]{64}$'
  AND "publicKeyX" ~ '^[0-9a-f]{64}$'
  AND "publicKeyY" ~ '^[0-9a-f]{64}$'
  AND "validatorPurpose" BETWEEN 0 AND 3
  AND ("kind" <> 'DEVICE_KEY' OR "credentialRef" ~ '^0x[0-9a-f]{64}$')
  AND ("kind" <> 'PASSKEY' OR "rpId" IS NOT NULL)
);
ALTER TABLE "WalletCredential" ADD CONSTRAINT "WalletCredential_lifecycle_consistent" CHECK (
  ("status" <> 'REPLACED' OR "replacedAt" IS NOT NULL)
  AND ("status" <> 'REVOKED' OR "revokedAt" IS NOT NULL)
  AND ("status" <> 'ACTIVE' OR "activatedAt" IS NOT NULL)
);

-- ── RecoveryConfiguration ────────────────────────────────────────────────────────────────────────
-- One armed recovery per wallet at a time.
CREATE UNIQUE INDEX "RecoveryConfiguration_one_active_per_wallet"
  ON "RecoveryConfiguration" ("walletId") WHERE "status" = 'ACTIVE';
ALTER TABLE "RecoveryConfiguration" ADD CONSTRAINT "RecoveryConfiguration_wellformed" CHECK (
  "validatorAddress" ~ '^0x[0-9a-f]{40}$'
  AND "recoveryAddress" ~ '^0x[0-9a-f]{40}$'
  AND "delaySeconds" > 0
  AND "recoveryNonce" ~ '^(0|[1-9][0-9]*)$'
  AND ("installUserOpHash" IS NULL OR "installUserOpHash" ~ '^0x[0-9a-f]{64}$')
);
ALTER TABLE "RecoveryConfiguration" ADD CONSTRAINT "RecoveryConfiguration_active_is_configured" CHECK (
  "status" <> 'ACTIVE' OR "configuredAt" IS NOT NULL
);

-- ── RecoveryAttempt ──────────────────────────────────────────────────────────────────────────────
-- One live attempt per wallet: a second start while one is running is refused by the database.
CREATE UNIQUE INDEX "RecoveryAttempt_one_live_per_wallet"
  ON "RecoveryAttempt" ("walletId")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED', 'VETOED', 'EXPIRED', 'FAILED');
CREATE INDEX "RecoveryAttempt_matured_idx"
  ON "RecoveryAttempt" ("executeAfter") WHERE "status" = 'PENDING';

ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_tokens_are_digests" CHECK (
  "tokenHash" ~ '^[0-9a-f]{64}$'
  AND ("cancelTokenHash" IS NULL OR "cancelTokenHash" ~ '^[0-9a-f]{64}$')
);
-- Email verification comes first: nothing past EMAIL_PENDING (that is not an expiry) exists without it.
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_email_before_anything" CHECK (
  "status" IN ('EMAIL_PENDING', 'EXPIRED', 'FAILED') OR "emailVerifiedAt" IS NOT NULL
);
-- A root proposal fixes the exact commitment; every chain stage carries it.
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_proposal_complete" CHECK (
  "status" NOT IN ('ROOT_PROPOSED', 'INITIATING', 'PENDING', 'FINALIZING', 'ROOT_CHANGED', 'COMPLETED')
  OR ("newRootKind" IS NOT NULL
      AND "newValidator" IS NOT NULL
      AND "newValidatorData" IS NOT NULL
      AND "newValidatorDataHash" IS NOT NULL
      AND "newHook" IS NOT NULL
      AND "newHookData" IS NOT NULL
      AND "newHookDataHash" IS NOT NULL
      AND "commitmentHash" IS NOT NULL
      AND "recoveryNonce" IS NOT NULL
      AND "newCredentialId" IS NOT NULL)
);
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_onchain_stage_complete" CHECK (
  "status" NOT IN ('PENDING', 'FINALIZING', 'ROOT_CHANGED', 'COMPLETED')
  OR ("executeAfter" IS NOT NULL AND "initiatedAt" IS NOT NULL AND "initiateTxHash" IS NOT NULL)
);
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_completion_requires_proof" CHECK (
  "status" <> 'COMPLETED'
  OR ("rootConfirmedAt" IS NOT NULL AND "proofVerifiedAt" IS NOT NULL AND "completedAt" IS NOT NULL)
);
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_root_changed_confirmed" CHECK (
  "status" NOT IN ('ROOT_CHANGED', 'COMPLETED') OR "rootConfirmedAt" IS NOT NULL
);
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_termination_consistent" CHECK (
  ("status" NOT IN ('CANCELLED', 'VETOED', 'EXPIRED', 'FAILED') OR "terminatedAt" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR "terminatedBy" = 'ROOT')
  AND ("status" <> 'VETOED' OR "terminatedBy" = 'ATTESTOR')
);
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_hashes_wellformed" CHECK (
  ("commitmentHash" IS NULL OR "commitmentHash" ~ '^0x[0-9a-f]{64}$')
  AND ("newValidatorDataHash" IS NULL OR "newValidatorDataHash" ~ '^0x[0-9a-f]{64}$')
  AND ("newHookDataHash" IS NULL OR "newHookDataHash" ~ '^0x[0-9a-f]{64}$')
  AND ("newValidator" IS NULL OR "newValidator" ~ '^0x[0-9a-f]{40}$')
  AND ("newHook" IS NULL OR "newHook" ~ '^0x[0-9a-f]{40}$')
  AND ("initiateTxHash" IS NULL OR "initiateTxHash" ~ '^0x[0-9a-f]{64}$')
  AND ("finalizeUserOpHash" IS NULL OR "finalizeUserOpHash" ~ '^0x[0-9a-f]{64}$')
  AND ("finalizeTxHash" IS NULL OR "finalizeTxHash" ~ '^0x[0-9a-f]{64}$')
  AND ("terminationTxHash" IS NULL OR "terminationTxHash" ~ '^0x[0-9a-f]{64}$')
  AND ("proofChallenge" IS NULL OR "proofChallenge" ~ '^0x[0-9a-f]{64}$')
  AND ("recoveryNonce" IS NULL OR "recoveryNonce" ~ '^(0|[1-9][0-9]*)$')
  AND ("nonceBefore" IS NULL OR "nonceBefore" >= 0)
);
-- A lease is held by a name for a time, or not at all.
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_lease_consistent" CHECK (
  ("lockedBy" IS NULL) = ("lockedUntil" IS NULL)
);

-- ── RecoveryEmailChallenge ───────────────────────────────────────────────────────────────────────
ALTER TABLE "RecoveryEmailChallenge" ADD CONSTRAINT "RecoveryEmailChallenge_budget" CHECK (
  "maxAttempts" > 0 AND "attempts" >= 0 AND "attempts" <= "maxAttempts"
  AND "codeHash" ~ '^[0-9a-f]{64}$'
);
