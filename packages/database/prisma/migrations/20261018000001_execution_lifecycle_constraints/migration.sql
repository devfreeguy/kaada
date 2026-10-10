-- Execution lifecycle constraints (hand-written). The database refuses states that would let a payment
-- sign before its authorization was consumed, keep a destroyed secret, or confuse a UserOperation
-- hash with a transaction hash.

-- Payment executions may now move through signing, submitting and settlement, but only AFTER the
-- authorization was consumed. Replaces the Build 12 "pre-execution only" rule.
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_plan_stage_is_pre_execution";
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_payment_status_allowed" CHECK (
  "paymentAuthorizationId" IS NULL
  OR "status" IN ('PREPARING', 'READY', 'BLOCKED', 'EXPIRED', 'FAILED', 'REQUIRES_USER_ACTION',
                  'SIGNING', 'SUBMITTING', 'SUBMITTED', 'SETTLING', 'COMPLETED')
);
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_consumed_before_signing" CHECK (
  "paymentAuthorizationId" IS NULL
  OR "status" NOT IN ('SIGNING', 'SUBMITTING', 'SUBMITTED', 'SETTLING', 'COMPLETED')
  OR "authorizationConsumedAt" IS NOT NULL
);
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_settled_amounts_canonical" CHECK (
  ("settledInputAmount" IS NULL OR "settledInputAmount" ~ '^(0|[1-9][0-9]*)$')
  AND ("settledOutputAmount" IS NULL OR "settledOutputAmount" ~ '^(0|[1-9][0-9]*)$')
);
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_submit_state_known" CHECK (
  "providerSubmitState" IS NULL OR "providerSubmitState" IN ('PENDING', 'SUBMITTED', 'FAILED')
);

-- Transactions: a transaction hash and a UserOperation hash are both 32-byte lower-case hex, and a
-- step has at most one row per idempotency key (already unique).
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_hashes_wellformed" CHECK (
  ("hash" IS NULL OR "hash" ~ '^0x[0-9a-f]{64}$')
  AND ("userOpHash" IS NULL OR "userOpHash" ~ '^0x[0-9a-f]{64}$')
);
CREATE INDEX "Transaction_userOpHash_idx" ON "Transaction" ("userOpHash");

-- A destroyed secret has no ciphertext, and a live one has an AEAD envelope (checked earlier).
ALTER TABLE "ExecutionSecret" ADD CONSTRAINT "ExecutionSecret_tombstone_consistent" CHECK (
  ("ciphertext" IS NULL) = ("tombstonedAt" IS NOT NULL)
);

-- Root action sessions: token stored only as a SHA-256 digest, time moves forward, used iff completed.
ALTER TABLE "RootActionSession" ADD CONSTRAINT "RootActionSession_tokenHash_sha256" CHECK ("tokenHash" IS NULL OR "tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "RootActionSession" ADD CONSTRAINT "RootActionSession_expiry_after_creation" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "RootActionSession" ADD CONSTRAINT "RootActionSession_used_iff_completed" CHECK (("status" = 'COMPLETED') = ("usedAt" IS NOT NULL));
ALTER TABLE "RootActionSession" ADD CONSTRAINT "RootActionSession_challenge_hex" CHECK ("challenge" ~ '^0x[0-9a-f]{64}$');
-- At most one open root action per execution.
CREATE UNIQUE INDEX "RootActionSession_one_pending_per_execution_key" ON "RootActionSession" ("executionId") WHERE "status" = 'PENDING';

-- A session key address exists exactly when its encrypted key does.
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_session_key_complete" CHECK (
  ("sessionKeyAddress" IS NULL) = ("sessionKeySecretId" IS NULL)
  AND ("sessionKeyAddress" IS NULL OR "sessionKeyAddress" ~ '^0x[0-9a-f]{40}$')
);
