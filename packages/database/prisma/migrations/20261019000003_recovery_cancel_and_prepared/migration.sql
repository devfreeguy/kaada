-- The root cancel operation and the arming operation are prepared and stored server-side (the signer only returns a
-- signature over the stored hash), and wrong Recovery Code proofs are counted.
ALTER TABLE "RecoveryAttempt" ADD COLUMN "proofFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RecoveryAttempt" ADD COLUMN "cancelChallenge" TEXT;
ALTER TABLE "RecoveryAttempt" ADD COLUMN "cancelPrepared" JSONB;
ALTER TABLE "RecoveryAttempt" ADD COLUMN "cancelUserOpHash" TEXT;
ALTER TABLE "RecoveryConfiguration" ADD COLUMN "preparedOperation" JSONB;
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_proof_failures_nonnegative" CHECK ("proofFailures" >= 0);
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_cancel_hashes_wellformed" CHECK (
  ("cancelChallenge" IS NULL OR "cancelChallenge" ~ '^0x[0-9a-f]{64}$')
  AND ("cancelUserOpHash" IS NULL OR "cancelUserOpHash" ~ '^0x[0-9a-f]{64}$')
);
