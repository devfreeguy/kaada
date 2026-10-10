-- CreateEnum
CREATE TYPE "FirmQuoteAttemptStatus" AS ENUM ('REQUESTING', 'QUOTED', 'UNUSABLE', 'EXPIRED', 'FAILED', 'TIMED_OUT');
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "ExecutionStatus" ADD VALUE 'PREPARING';
ALTER TYPE "ExecutionStatus" ADD VALUE 'READY';
ALTER TYPE "ExecutionStatus" ADD VALUE 'BLOCKED';
-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "firmQuoteAttemptId" UUID,
ADD COLUMN     "paymentAuthorizationId" UUID,
ADD COLUMN     "plan" JSONB,
ADD COLUMN     "walletId" UUID;
-- CreateTable
CREATE TABLE "ExecutionSecret" (
    "id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExecutionSecret_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "FirmQuoteAttempt" (
    "id" UUID NOT NULL,
    "paymentAuthorizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "status" "FirmQuoteAttemptStatus" NOT NULL DEFAULT 'REQUESTING',
    "idempotencyKey" TEXT NOT NULL,
    "amountMode" "AmountMode" NOT NULL,
    "exactAmount" TEXT NOT NULL,
    "exactAssetId" UUID NOT NULL,
    "takerAddress" TEXT NOT NULL,
    "providerQuoteId" TEXT,
    "inputAmount" TEXT,
    "inputAssetId" UUID,
    "outputAmount" TEXT,
    "outputAssetId" UUID,
    "feeAmount" TEXT,
    "feeAssetId" UUID,
    "reactor" TEXT,
    "spender" TEXT,
    "expiresAt" TIMESTAMPTZ(3),
    "orderDeadline" TIMESTAMPTZ(3),
    "latestOrderDeadline" TIMESTAMPTZ(3),
    "unsignedTransactions" JSONB,
    "claimSecretId" UUID,
    "failureCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "FirmQuoteAttempt_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "FirmQuoteAttempt_idempotencyKey_key" ON "FirmQuoteAttempt"("idempotencyKey");
-- CreateIndex
CREATE INDEX "FirmQuoteAttempt_paymentAuthorizationId_status_idx" ON "FirmQuoteAttempt"("paymentAuthorizationId", "status");
-- CreateIndex
CREATE INDEX "FirmQuoteAttempt_providerId_status_idx" ON "FirmQuoteAttempt"("providerId", "status");
-- CreateIndex
CREATE UNIQUE INDEX "Execution_paymentAuthorizationId_key" ON "Execution"("paymentAuthorizationId");
-- AddForeignKey
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_paymentAuthorizationId_fkey" FOREIGN KEY ("paymentAuthorizationId") REFERENCES "PaymentAuthorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_claimSecretId_fkey" FOREIGN KEY ("claimSecretId") REFERENCES "ExecutionSecret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_exactAssetId_fkey" FOREIGN KEY ("exactAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_inputAssetId_fkey" FOREIGN KEY ("inputAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_outputAssetId_fkey" FOREIGN KEY ("outputAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FirmQuoteAttempt" ADD CONSTRAINT "FirmQuoteAttempt_feeAssetId_fkey" FOREIGN KEY ("feeAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_paymentAuthorizationId_fkey" FOREIGN KEY ("paymentAuthorizationId") REFERENCES "PaymentAuthorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_firmQuoteAttemptId_fkey" FOREIGN KEY ("firmQuoteAttemptId") REFERENCES "FirmQuoteAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
