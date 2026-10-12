-- CreateEnum
CREATE TYPE "WalletCredentialKind" AS ENUM ('PASSKEY', 'DEVICE_KEY');

-- CreateEnum
CREATE TYPE "WalletCredentialRole" AS ENUM ('PRIMARY', 'BACKUP', 'RECOVERY');

-- CreateEnum
CREATE TYPE "WalletCredentialStatus" AS ENUM ('PENDING', 'ACTIVE', 'REPLACED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DeviceSecurityTier" AS ENUM ('UNKNOWN', 'WEB_NON_EXTRACTABLE', 'TRUSTED_DEVICE');

-- CreateEnum
CREATE TYPE "RecoveryConfigurationStatus" AS ENUM ('PENDING_INSTALL', 'ACTIVE', 'CONSUMED', 'SUPERSEDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "RecoveryAttemptStatus" AS ENUM ('EMAIL_PENDING', 'EMAIL_VERIFIED', 'ROOT_PROPOSED', 'INITIATING', 'PENDING', 'FINALIZING', 'ROOT_CHANGED', 'COMPLETED', 'CANCELLED', 'VETOED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "RecoveryTerminator" AS ENUM ('ROOT', 'ATTESTOR', 'SYSTEM');

-- CreateTable
CREATE TABLE "WalletCredential" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "kind" "WalletCredentialKind" NOT NULL,
    "role" "WalletCredentialRole" NOT NULL,
    "status" "WalletCredentialStatus" NOT NULL DEFAULT 'PENDING',
    "isRoot" BOOLEAN NOT NULL DEFAULT false,
    "validatorAddress" TEXT NOT NULL,
    "validatorPurpose" INTEGER NOT NULL,
    "deploymentSalt" TEXT NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "publicKeyX" CHAR(64) NOT NULL,
    "publicKeyY" CHAR(64) NOT NULL,
    "rpId" TEXT,
    "passkeyCredentialId" UUID,
    "securityTier" "DeviceSecurityTier" NOT NULL DEFAULT 'UNKNOWN',
    "label" TEXT,
    "replacedByCredentialId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(3),
    "replacedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WalletCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryConfiguration" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "validatorAddress" TEXT NOT NULL,
    "recoveryAddress" TEXT NOT NULL,
    "delaySeconds" INTEGER NOT NULL,
    "status" "RecoveryConfigurationStatus" NOT NULL DEFAULT 'PENDING_INSTALL',
    "armedByCredentialId" UUID,
    "recoveryNonce" TEXT NOT NULL DEFAULT '0',
    "installUserOpHash" TEXT,
    "configuredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RecoveryConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryAttempt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "configurationId" UUID,
    "status" "RecoveryAttemptStatus" NOT NULL DEFAULT 'EMAIL_PENDING',
    "tokenHash" CHAR(64) NOT NULL,
    "tokenExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "cancelTokenHash" CHAR(64),
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "newCredentialId" UUID,
    "newRootKind" "WalletCredentialKind",
    "newValidator" TEXT,
    "newValidatorData" TEXT,
    "newValidatorDataHash" TEXT,
    "newHook" TEXT,
    "newHookData" TEXT,
    "newHookDataHash" TEXT,
    "commitmentHash" TEXT,
    "recoveryNonce" TEXT,
    "proofDeadline" TIMESTAMPTZ(3),
    "proposedAt" TIMESTAMPTZ(3),
    "previousRootValidator" TEXT,
    "initiatedAt" TIMESTAMPTZ(3),
    "executeAfter" TIMESTAMPTZ(3),
    "initiateTxHash" TEXT,
    "nonceBefore" INTEGER,
    "finalizeUserOpHash" TEXT,
    "finalizeTxHash" TEXT,
    "blockedReason" TEXT,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "rootConfirmedAt" TIMESTAMPTZ(3),
    "proofChallenge" TEXT,
    "proofVerifiedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "terminatedBy" "RecoveryTerminator",
    "terminatedAt" TIMESTAMPTZ(3),
    "terminationTxHash" TEXT,
    "failureCode" TEXT,
    "cleanupCompletedAt" TIMESTAMPTZ(3),
    "pinResetAt" TIMESTAMPTZ(3),
    "newConfigurationId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RecoveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryEmailChallenge" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryEmailChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletCredential_walletId_status_idx" ON "WalletCredential"("walletId", "status");

-- CreateIndex
CREATE INDEX "WalletCredential_userId_idx" ON "WalletCredential"("userId");

-- CreateIndex
CREATE INDEX "RecoveryConfiguration_walletId_status_idx" ON "RecoveryConfiguration"("walletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryAttempt_tokenHash_key" ON "RecoveryAttempt"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryAttempt_cancelTokenHash_key" ON "RecoveryAttempt"("cancelTokenHash");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_walletId_status_idx" ON "RecoveryAttempt"("walletId", "status");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_userId_createdAt_idx" ON "RecoveryAttempt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_status_executeAfter_idx" ON "RecoveryAttempt"("status", "executeAfter");

-- CreateIndex
CREATE INDEX "RecoveryEmailChallenge_attemptId_createdAt_idx" ON "RecoveryEmailChallenge"("attemptId", "createdAt");

-- AddForeignKey
ALTER TABLE "WalletCredential" ADD CONSTRAINT "WalletCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletCredential" ADD CONSTRAINT "WalletCredential_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryConfiguration" ADD CONSTRAINT "RecoveryConfiguration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryConfiguration" ADD CONSTRAINT "RecoveryConfiguration_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryConfiguration" ADD CONSTRAINT "RecoveryConfiguration_armedByCredentialId_fkey" FOREIGN KEY ("armedByCredentialId") REFERENCES "WalletCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "RecoveryConfiguration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_newCredentialId_fkey" FOREIGN KEY ("newCredentialId") REFERENCES "WalletCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_newConfigurationId_fkey" FOREIGN KEY ("newConfigurationId") REFERENCES "RecoveryConfiguration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryEmailChallenge" ADD CONSTRAINT "RecoveryEmailChallenge_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RecoveryAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

