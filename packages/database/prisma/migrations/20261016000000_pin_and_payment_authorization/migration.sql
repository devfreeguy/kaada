-- CreateEnum
CREATE TYPE "AuthorizationSessionStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'EXPIRED', 'CANCELLED');
-- CreateEnum
CREATE TYPE "PaymentAuthorizationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED');
-- CreateTable
CREATE TABLE "TransactionPinSecurity" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pinHash" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockLevel" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "changedAt" TIMESTAMPTZ(3) NOT NULL,
    "resetRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TransactionPinSecurity_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AuthorizationSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "intentRevision" INTEGER NOT NULL,
    "routeId" UUID NOT NULL,
    "tokenHash" CHAR(64),
    "tokenIssuedAt" TIMESTAMPTZ(3),
    "status" "AuthorizationSessionStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthorizationSession_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PaymentAuthorization" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "intentRevision" INTEGER NOT NULL,
    "routeId" UUID NOT NULL,
    "sessionId" UUID,
    "status" "PaymentAuthorizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "operation" "IntentType" NOT NULL,
    "chainId" INTEGER NOT NULL,
    "recipientId" UUID,
    "recipientAddress" TEXT,
    "destinationCountry" TEXT,
    "amountMode" "AmountMode" NOT NULL,
    "inputAssetId" UUID NOT NULL,
    "outputAssetId" UUID NOT NULL,
    "maxInputAmount" TEXT NOT NULL,
    "minOutputAmount" TEXT NOT NULL,
    "routeAssetPath" UUID[],
    "routeProviders" TEXT[],
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revocationReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentAuthorization_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "TransactionPinSecurity_userId_key" ON "TransactionPinSecurity"("userId");
-- CreateIndex
CREATE UNIQUE INDEX "AuthorizationSession_tokenHash_key" ON "AuthorizationSession"("tokenHash");
-- CreateIndex
CREATE INDEX "AuthorizationSession_userId_status_idx" ON "AuthorizationSession"("userId", "status");
-- CreateIndex
CREATE INDEX "AuthorizationSession_intentId_status_idx" ON "AuthorizationSession"("intentId", "status");
-- CreateIndex
CREATE INDEX "PaymentAuthorization_userId_status_idx" ON "PaymentAuthorization"("userId", "status");
-- CreateIndex
CREATE INDEX "PaymentAuthorization_intentId_status_idx" ON "PaymentAuthorization"("intentId", "status");
-- AddForeignKey
ALTER TABLE "TransactionPinSecurity" ADD CONSTRAINT "TransactionPinSecurity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AuthorizationSession" ADD CONSTRAINT "AuthorizationSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AuthorizationSession" ADD CONSTRAINT "AuthorizationSession_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AuthorizationSession" ADD CONSTRAINT "AuthorizationSession_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "Intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AuthorizationSession" ADD CONSTRAINT "AuthorizationSession_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "Intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuthorizationSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_inputAssetId_fkey" FOREIGN KEY ("inputAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_outputAssetId_fkey" FOREIGN KEY ("outputAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
