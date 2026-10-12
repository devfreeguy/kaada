-- CreateEnum
CREATE TYPE "AttestationPlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "AttestationChallengePurpose" AS ENUM ('ROOT_ENROLLMENT', 'BACKUP_ENROLLMENT', 'RECOVERY_ROOT');

-- CreateEnum
CREATE TYPE "AttestationResult" AS ENUM ('VERIFIED_QUALIFIED', 'VERIFIED_NOT_QUALIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AttestationHardwareLevel" AS ENUM ('STRONGBOX', 'TEE', 'SOFTWARE');

-- AlterEnum
ALTER TYPE "DeviceSecurityTier" ADD VALUE 'APP_ATTESTED_DEVICE';

-- CreateTable
CREATE TABLE "DeviceAttestationChallenge" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID,
    "platform" "AttestationPlatform" NOT NULL,
    "purpose" "AttestationChallengePurpose" NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "consumedPublicKeyHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAttestationChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceAttestation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID,
    "challengeId" UUID NOT NULL,
    "platform" "AttestationPlatform" NOT NULL,
    "attestationType" TEXT NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "publicKeyHash" TEXT NOT NULL,
    "result" "AttestationResult" NOT NULL,
    "reason" TEXT,
    "hardwareLevel" "AttestationHardwareLevel",
    "derivedTier" "DeviceSecurityTier" NOT NULL,
    "verifierVersion" INTEGER NOT NULL,
    "facts" JSONB NOT NULL,
    "chainHashes" TEXT[],
    "trustAnchor" TEXT,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceAttestationChallenge_nonce_key" ON "DeviceAttestationChallenge"("nonce");

-- CreateIndex
CREATE INDEX "DeviceAttestationChallenge_userId_purpose_idx" ON "DeviceAttestationChallenge"("userId", "purpose");

-- CreateIndex
CREATE INDEX "DeviceAttestationChallenge_expiresAt_idx" ON "DeviceAttestationChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceAttestation_challengeId_key" ON "DeviceAttestation"("challengeId");

-- CreateIndex
CREATE INDEX "DeviceAttestation_userId_publicKeyHash_idx" ON "DeviceAttestation"("userId", "publicKeyHash");

-- AddForeignKey
ALTER TABLE "DeviceAttestationChallenge" ADD CONSTRAINT "DeviceAttestationChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAttestationChallenge" ADD CONSTRAINT "DeviceAttestationChallenge_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAttestation" ADD CONSTRAINT "DeviceAttestation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAttestation" ADD CONSTRAINT "DeviceAttestation_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAttestation" ADD CONSTRAINT "DeviceAttestation_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "DeviceAttestationChallenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

