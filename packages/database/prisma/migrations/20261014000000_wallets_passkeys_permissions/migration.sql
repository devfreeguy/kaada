-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('EMBEDDED', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'RECOVERY_REQUIRED');

-- CreateEnum
CREATE TYPE "WalletDeployment" AS ENUM ('NOT_APPLICABLE', 'COUNTERFACTUAL', 'DEPLOYING', 'DEPLOYED');

-- CreateEnum
CREATE TYPE "PermissionStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PasskeyChallengePurpose" AS ENUM ('REGISTRATION', 'AUTHENTICATION');

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "deployment" "WalletDeployment" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerAccountId" TEXT,
ADD COLUMN     "provisionedAt" TIMESTAMPTZ(3),
ADD COLUMN     "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "statusReason" TEXT,
ADD COLUMN     "type" "WalletType" NOT NULL DEFAULT 'EXTERNAL',
ALTER COLUMN "address" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PasskeyCredential" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKeyX" CHAR(64) NOT NULL,
    "publicKeyY" CHAR(64) NOT NULL,
    "rpId" TEXT NOT NULL,
    "signCount" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasskeyChallenge" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" "PasskeyChallengePurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasskeyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegatedPermission" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPermissionId" TEXT,
    "chainId" INTEGER NOT NULL,
    "status" "PermissionStatus" NOT NULL DEFAULT 'PENDING',
    "allowedOperations" TEXT[],
    "allowedContracts" TEXT[],
    "allowedAssetIds" UUID[],
    "perTransactionAmount" TEXT NOT NULL,
    "perTransactionAssetId" UUID NOT NULL,
    "cumulativeAmount" TEXT,
    "cumulativeAssetId" UUID,
    "enforcement" JSONB NOT NULL,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revocationReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DelegatedPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyCredential_credentialId_key" ON "PasskeyCredential"("credentialId");

-- CreateIndex
CREATE INDEX "PasskeyCredential_userId_idx" ON "PasskeyCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyChallenge_challenge_key" ON "PasskeyChallenge"("challenge");

-- CreateIndex
CREATE INDEX "PasskeyChallenge_userId_purpose_idx" ON "PasskeyChallenge"("userId", "purpose");

-- CreateIndex
CREATE INDEX "DelegatedPermission_walletId_status_idx" ON "DelegatedPermission"("walletId", "status");

-- CreateIndex
CREATE INDEX "DelegatedPermission_userId_idx" ON "DelegatedPermission"("userId");

-- AddForeignKey
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasskeyChallenge" ADD CONSTRAINT "PasskeyChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_perTransactionAssetId_fkey" FOREIGN KEY ("perTransactionAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_cumulativeAssetId_fkey" FOREIGN KEY ("cumulativeAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

