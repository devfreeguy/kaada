-- CreateEnum
CREATE TYPE "RootChangeKind" AS ENUM ('ROTATE_ROOT', 'ENROLL_BACKUP');

-- CreateEnum
CREATE TYPE "RootChangeStatus" AS ENUM ('PREPARED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "RootChange" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "kind" "RootChangeKind" NOT NULL,
    "status" "RootChangeStatus" NOT NULL DEFAULT 'PREPARED',
    "newCredentialId" UUID NOT NULL,
    "signerCredentialId" UUID,
    "challenge" TEXT NOT NULL,
    "prepared" JSONB NOT NULL,
    "userOpHash" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "failureCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RootChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RootChange_walletId_status_idx" ON "RootChange"("walletId", "status");

-- CreateIndex
CREATE INDEX "RootChange_userId_idx" ON "RootChange"("userId");

-- AddForeignKey
ALTER TABLE "RootChange" ADD CONSTRAINT "RootChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RootChange" ADD CONSTRAINT "RootChange_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RootChange" ADD CONSTRAINT "RootChange_newCredentialId_fkey" FOREIGN KEY ("newCredentialId") REFERENCES "WalletCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one live change per wallet: a second rotation or enrolment while one is running is refused by the database.
CREATE UNIQUE INDEX "RootChange_one_live_per_wallet"
  ON "RootChange" ("walletId") WHERE "status" IN ('PREPARED', 'SUBMITTED');

ALTER TABLE "RootChange" ADD CONSTRAINT "RootChange_wellformed" CHECK (
  "challenge" ~ '^0x[0-9a-f]{64}$'
  AND ("userOpHash" IS NULL OR "userOpHash" ~ '^0x[0-9a-f]{64}$')
  AND ("status" <> 'SUBMITTED' OR "userOpHash" IS NOT NULL)
  AND ("status" <> 'CONFIRMED' OR "completedAt" IS NOT NULL)
);
