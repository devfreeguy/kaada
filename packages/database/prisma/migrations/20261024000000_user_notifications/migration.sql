-- CreateEnum
CREATE TYPE "UserNotificationKind" AS ENUM ('ONBOARDING_STARTED', 'WALLET_ROOT_CREATED', 'WALLET_READY', 'PIN_CREATED', 'RECOVERY_CONFIGURED', 'ONBOARDING_COMPLETED');

-- CreateTable
CREATE TABLE "UserNotification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "UserNotificationKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserNotification_userId_kind_key" ON "UserNotification"("userId", "kind");

-- CreateIndex
CREATE INDEX "UserNotification_deliveredAt_createdAt_idx" ON "UserNotification"("deliveredAt", "createdAt");

-- AddForeignKey
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_attempts_check" CHECK ("attempts" >= 0);
