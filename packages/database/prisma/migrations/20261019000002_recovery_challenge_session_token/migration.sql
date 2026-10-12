-- A challenge unlocks a specific session token: a restart for a live attempt gets a NEW token that only replaces the
-- attempt token once the emailed code is verified (an unverified start can never take over a session).
ALTER TABLE "RecoveryEmailChallenge" ADD COLUMN "sessionTokenHash" CHAR(64) NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE "RecoveryEmailChallenge" ALTER COLUMN "sessionTokenHash" DROP DEFAULT;
ALTER TABLE "RecoveryEmailChallenge" ADD CONSTRAINT "RecoveryEmailChallenge_session_token_digest" CHECK (
  "sessionTokenHash" ~ '^[0-9a-f]{64}$'
);
CREATE INDEX "RecoveryEmailChallenge_sessionTokenHash_createdAt_idx"
  ON "RecoveryEmailChallenge" ("sessionTokenHash", "createdAt");
