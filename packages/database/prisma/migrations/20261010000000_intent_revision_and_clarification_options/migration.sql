-- AlterTable
ALTER TABLE "Intent" ADD COLUMN     "preferredSourceAssetId" UUID,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "ClarificationOption" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "value" JSONB NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClarificationOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClarificationOption_intentId_createdAt_idx" ON "ClarificationOption"("intentId", "createdAt");

-- CreateIndex
CREATE INDEX "ClarificationOption_groupId_idx" ON "ClarificationOption"("groupId");

-- AddForeignKey
ALTER TABLE "Intent" ADD CONSTRAINT "Intent_preferredSourceAssetId_fkey" FOREIGN KEY ("preferredSourceAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClarificationOption" ADD CONSTRAINT "ClarificationOption_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClarificationOption" ADD CONSTRAINT "ClarificationOption_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "Intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written (Prisma does not manage CHECK constraints): a revision starts at 1 and only grows.
ALTER TABLE "Intent" ADD CONSTRAINT "Intent_revision_positive" CHECK ("revision" >= 1);
