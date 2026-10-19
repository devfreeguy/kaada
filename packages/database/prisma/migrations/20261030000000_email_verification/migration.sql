-- A person proves they control the email address they will use for account recovery: a 6-digit code, stored only as a keyed hash,
-- sent to the address; the address becomes their EMAIL identity only after the right code is entered.

CREATE TABLE "EmailVerification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailVerification_userId_createdAt_idx" ON "EmailVerification"("userId", "createdAt");

ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The guess budget is a database rule, not only application code.
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_attempts_range"
  CHECK ("attempts" >= 0 AND "maxAttempts" > 0 AND "attempts" <= "maxAttempts");
