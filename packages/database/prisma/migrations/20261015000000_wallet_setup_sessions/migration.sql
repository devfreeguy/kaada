-- CreateEnum
CREATE TYPE "WalletSetupStatus" AS ENUM ('PENDING', 'COMPLETED', 'REVOKED');

-- CreateTable
CREATE TABLE "WalletSetupSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "status" "WalletSetupStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletSetupSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletSetupSession_tokenHash_key" ON "WalletSetupSession"("tokenHash");

-- CreateIndex
CREATE INDEX "WalletSetupSession_userId_status_idx" ON "WalletSetupSession"("userId", "status");

-- AddForeignKey
ALTER TABLE "WalletSetupSession" ADD CONSTRAINT "WalletSetupSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The stored value must be a SHA-256 hex digest (never a raw token), and only a COMPLETED session
-- has a use time.
ALTER TABLE "WalletSetupSession" ADD CONSTRAINT "WalletSetupSession_tokenHash_sha256" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "WalletSetupSession" ADD CONSTRAINT "WalletSetupSession_used_iff_completed" CHECK (("status" = 'COMPLETED') = ("usedAt" IS NOT NULL));
ALTER TABLE "WalletSetupSession" ADD CONSTRAINT "WalletSetupSession_expiry_after_creation" CHECK ("expiresAt" > "createdAt");
