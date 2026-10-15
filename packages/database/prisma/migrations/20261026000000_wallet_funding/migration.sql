-- CreateTable
CREATE TABLE "WalletBalanceCheckpoint" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "balances" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WalletBalanceCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletFundingEvent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "checkpointId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WalletFundingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletBalanceCheckpoint_chainId_address_key" ON "WalletBalanceCheckpoint"("chainId", "address");

-- CreateIndex
CREATE INDEX "WalletBalanceCheckpoint_userId_idx" ON "WalletBalanceCheckpoint"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingEvent_checkpointId_version_key" ON "WalletFundingEvent"("checkpointId", "version");

-- CreateIndex
CREATE INDEX "WalletFundingEvent_deliveredAt_createdAt_idx" ON "WalletFundingEvent"("deliveredAt", "createdAt");

-- AddForeignKey
ALTER TABLE "WalletBalanceCheckpoint" ADD CONSTRAINT "WalletBalanceCheckpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingEvent" ADD CONSTRAINT "WalletFundingEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingEvent" ADD CONSTRAINT "WalletFundingEvent_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "WalletBalanceCheckpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WalletBalanceCheckpoint" ADD CONSTRAINT "WalletBalanceCheckpoint_version_check" CHECK ("version" >= 0);
ALTER TABLE "WalletFundingEvent" ADD CONSTRAINT "WalletFundingEvent_attempts_check" CHECK ("attempts" >= 0);
