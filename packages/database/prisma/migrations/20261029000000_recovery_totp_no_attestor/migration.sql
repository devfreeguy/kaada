-- Recovery is re-founded: registered email + Recovery Code + authenticator-app (TOTP) code + 72-hour delay.
-- There is no Kaada attestor: no attestor signature, no veto, no registry. The old VETOED status and ATTESTOR terminator go.
--
-- DESTRUCTIVE, on purpose and only for recovery: there are no production users and no production recovery data, and what
-- exists is development / test data that was armed against the superseded validator (whose ABI took an attestor registry).
-- Reset here, and ONLY here: RecoveryEmailChallenge, RecoveryAttempt, RecoveryConfiguration, and the PENDING recovery-role
-- WalletCredential rows that only those attempts referenced. Users, wallets, active/replaced credentials, passkeys, payments,
-- executions, authorizations, audit events and every other table are untouched.

-- ── 1. reset the recovery test data ──────────────────────────────────────────────────────────────
DELETE FROM "RecoveryEmailChallenge";
DELETE FROM "RecoveryAttempt";
DELETE FROM "RecoveryConfiguration";
DELETE FROM "WalletCredential" c
 WHERE c."role" = 'RECOVERY'
   AND c."status" = 'PENDING'
   AND NOT EXISTS (SELECT 1 FROM "RootChange" r WHERE r."newCredentialId" = c."id");

-- ── 2. drop everything that names a removed enum value, then retype the enums ───────────────────
DROP INDEX "RecoveryAttempt_one_live_per_wallet";
DROP INDEX "RecoveryAttempt_matured_idx";
ALTER TABLE "RecoveryAttempt" DROP CONSTRAINT "RecoveryAttempt_email_before_anything";
ALTER TABLE "RecoveryAttempt" DROP CONSTRAINT "RecoveryAttempt_proposal_complete";
ALTER TABLE "RecoveryAttempt" DROP CONSTRAINT "RecoveryAttempt_onchain_stage_complete";
ALTER TABLE "RecoveryAttempt" DROP CONSTRAINT "RecoveryAttempt_completion_requires_proof";
ALTER TABLE "RecoveryAttempt" DROP CONSTRAINT "RecoveryAttempt_root_changed_confirmed";
ALTER TABLE "RecoveryAttempt" DROP CONSTRAINT "RecoveryAttempt_termination_consistent";
ALTER TABLE "RecoveryAttempt" DROP CONSTRAINT "RecoveryAttempt_hashes_wellformed";

ALTER TABLE "RecoveryAttempt" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "RecoveryAttemptStatus" RENAME TO "RecoveryAttemptStatus_old";
CREATE TYPE "RecoveryAttemptStatus" AS ENUM ('EMAIL_PENDING', 'EMAIL_VERIFIED', 'ROOT_PROPOSED', 'INITIATING', 'PENDING', 'FINALIZING', 'ROOT_CHANGED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED');
ALTER TABLE "RecoveryAttempt" ALTER COLUMN "status" TYPE "RecoveryAttemptStatus" USING ("status"::text::"RecoveryAttemptStatus");
ALTER TABLE "RecoveryAttempt" ALTER COLUMN "status" SET DEFAULT 'EMAIL_PENDING';
DROP TYPE "RecoveryAttemptStatus_old";

ALTER TYPE "RecoveryTerminator" RENAME TO "RecoveryTerminator_old";
CREATE TYPE "RecoveryTerminator" AS ENUM ('ROOT', 'SYSTEM');
ALTER TABLE "RecoveryAttempt" ALTER COLUMN "terminatedBy" TYPE "RecoveryTerminator" USING ("terminatedBy"::text::"RecoveryTerminator");
DROP TYPE "RecoveryTerminator_old";

-- ── 3. the veto transaction is gone; the authenticator code that unlocked the attempt is recorded ─
ALTER TABLE "RecoveryAttempt" DROP COLUMN "terminationTxHash";
ALTER TABLE "RecoveryAttempt" ADD COLUMN "totpVerifiedAt" TIMESTAMPTZ(3);
ALTER TABLE "RecoveryAttempt" ADD COLUMN "totpStep" INTEGER;

-- ── 4. the constraints again, without the attestor, plus: no chain stage without the authenticator code ─
CREATE UNIQUE INDEX "RecoveryAttempt_one_live_per_wallet"
  ON "RecoveryAttempt" ("walletId")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED');
CREATE INDEX "RecoveryAttempt_matured_idx"
  ON "RecoveryAttempt" ("executeAfter") WHERE "status" = 'PENDING';

ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_email_before_anything" CHECK (
  "status" IN ('EMAIL_PENDING', 'EXPIRED', 'FAILED') OR "emailVerifiedAt" IS NOT NULL
);
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
  ("status" NOT IN ('CANCELLED', 'EXPIRED', 'FAILED') OR "terminatedAt" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR "terminatedBy" = 'ROOT')
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
  AND ("proofChallenge" IS NULL OR "proofChallenge" ~ '^0x[0-9a-f]{64}$')
  AND ("recoveryNonce" IS NULL OR "recoveryNonce" ~ '^(0|[1-9][0-9]*)$')
  AND ("nonceBefore" IS NULL OR "nonceBefore" >= 0)
);
-- The authenticator code is part of the recovery: no attempt reaches the chain, or anything after it, without one.
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_authenticator_before_chain" CHECK (
  "status" NOT IN ('INITIATING', 'PENDING', 'FINALIZING', 'ROOT_CHANGED', 'COMPLETED')
  OR ("totpVerifiedAt" IS NOT NULL AND "totpStep" IS NOT NULL)
);
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_totp_step_nonnegative" CHECK ("totpStep" IS NULL OR "totpStep" >= 0);

-- ── 5. the authenticator-app factor ──────────────────────────────────────────────────────────────
CREATE TYPE "RecoveryTotpStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

CREATE TABLE "RecoveryTotp" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "status" "RecoveryTotpStatus" NOT NULL DEFAULT 'PENDING',
    "encryptedSecret" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "enabledAt" TIMESTAMPTZ(3),
    "lastUsedStep" INTEGER,
    "disabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RecoveryTotp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecoveryTotp_walletId_status_idx" ON "RecoveryTotp"("walletId", "status");

ALTER TABLE "RecoveryTotp" ADD CONSTRAINT "RecoveryTotp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryTotp" ADD CONSTRAINT "RecoveryTotp_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one enrolment being set up and one in force per wallet.
CREATE UNIQUE INDEX "RecoveryTotp_one_active_per_wallet" ON "RecoveryTotp" ("walletId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "RecoveryTotp_one_pending_per_wallet" ON "RecoveryTotp" ("walletId") WHERE "status" = 'PENDING';

-- Only ciphertext is stored (AES-256-GCM, "v<keyVersion>.<nonce>.<ciphertext+tag>"); an ACTIVE one was proven by a code, so it has
-- a step, and steps only ever move forward (the application's conditional update; this keeps the values sane).
ALTER TABLE "RecoveryTotp" ADD CONSTRAINT "RecoveryTotp_secret_is_ciphertext" CHECK (
  "encryptedSecret" ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND "keyVersion" >= 1
);
ALTER TABLE "RecoveryTotp" ADD CONSTRAINT "RecoveryTotp_active_was_proven" CHECK (
  "status" <> 'ACTIVE' OR ("enabledAt" IS NOT NULL AND "lastUsedStep" IS NOT NULL)
);
ALTER TABLE "RecoveryTotp" ADD CONSTRAINT "RecoveryTotp_disabled_has_time" CHECK (
  "status" <> 'DISABLED' OR "disabledAt" IS NOT NULL
);
ALTER TABLE "RecoveryTotp" ADD CONSTRAINT "RecoveryTotp_step_nonnegative" CHECK ("lastUsedStep" IS NULL OR "lastUsedStep" >= 0);
