-- CreateEnum
CREATE TYPE "RootActionStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED');
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "ExecutionStatus" ADD VALUE 'SIGNING';
ALTER TYPE "ExecutionStatus" ADD VALUE 'SUBMITTING';
ALTER TYPE "ExecutionStatus" ADD VALUE 'SUBMITTED';
ALTER TYPE "ExecutionStatus" ADD VALUE 'REQUIRES_USER_ACTION';
-- AlterEnum
ALTER TYPE "TransactionStatus" ADD VALUE 'UNKNOWN';
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "TransactionType" ADD VALUE 'DEPLOYMENT';
ALTER TYPE "TransactionType" ADD VALUE 'PERMISSION_INSTALL';
-- AlterTable
ALTER TABLE "DelegatedPermission" ADD COLUMN     "approvalSecretId" UUID,
ADD COLUMN     "installedAt" TIMESTAMPTZ(3),
ADD COLUMN     "sessionKeyAddress" TEXT,
ADD COLUMN     "sessionKeySecretId" UUID;
-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "authorizationConsumedAt" TIMESTAMPTZ(3),
ADD COLUMN     "claimTombstonedAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastReconciledAt" TIMESTAMPTZ(3),
ADD COLUMN     "providerSubmitState" TEXT,
ADD COLUMN     "settledInputAmount" TEXT,
ADD COLUMN     "settledOutputAmount" TEXT,
ADD COLUMN     "userActionKind" TEXT;
-- AlterTable
ALTER TABLE "ExecutionSecret" ADD COLUMN     "tombstonedAt" TIMESTAMPTZ(3),
ALTER COLUMN "ciphertext" DROP NOT NULL;
-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "blockNumber" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMPTZ(3),
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMPTZ(3),
ADD COLUMN     "userOpHash" TEXT;
-- CreateTable
CREATE TABLE "RootActionSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" CHAR(64),
    "status" "RootActionStatus" NOT NULL DEFAULT 'PENDING',
    "challenge" TEXT NOT NULL,
    "prepared" JSONB NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RootActionSession_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "RootActionSession_tokenHash_key" ON "RootActionSession"("tokenHash");
-- CreateIndex
CREATE INDEX "RootActionSession_executionId_status_idx" ON "RootActionSession"("executionId", "status");
-- CreateIndex
CREATE UNIQUE INDEX "Transaction_idempotencyKey_key" ON "Transaction"("idempotencyKey");
-- AddForeignKey
ALTER TABLE "RootActionSession" ADD CONSTRAINT "RootActionSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "RootActionSession" ADD CONSTRAINT "RootActionSession_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "RootActionSession" ADD CONSTRAINT "RootActionSession_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_sessionKeySecretId_fkey" FOREIGN KEY ("sessionKeySecretId") REFERENCES "ExecutionSecret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_approvalSecretId_fkey" FOREIGN KEY ("approvalSecretId") REFERENCES "ExecutionSecret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
