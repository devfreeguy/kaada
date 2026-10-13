-- CreateEnum
CREATE TYPE "ChannelInboundStatus" AS ENUM ('RECEIVED', 'PROCESSED');

-- CreateEnum
CREATE TYPE "ChannelActionKind" AS ENUM ('SELECT_OPTION', 'CANCEL', 'VIEW_STATUS', 'RETRY');

-- CreateTable
CREATE TABLE "ChannelInboundEvent" (
    "id" UUID NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "status" "ChannelInboundStatus" NOT NULL DEFAULT 'RECEIVED',
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ChannelInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelAction" (
    "id" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "conversationId" UUID NOT NULL,
    "kind" "ChannelActionKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "reusable" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelPaymentStatus" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "externalConversationId" TEXT NOT NULL,
    "authorizationSessionId" UUID NOT NULL,
    "externalSummaryMessageId" TEXT,
    "externalStatusMessageId" TEXT,
    "lastState" TEXT NOT NULL,
    "terminal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChannelPaymentStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelInboundEvent_receivedAt_idx" ON "ChannelInboundEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelInboundEvent_channel_externalEventId_key" ON "ChannelInboundEvent"("channel", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAction_handle_key" ON "ChannelAction"("handle");

-- CreateIndex
CREATE INDEX "ChannelAction_userId_idx" ON "ChannelAction"("userId");

-- CreateIndex
CREATE INDEX "ChannelAction_expiresAt_idx" ON "ChannelAction"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelPaymentStatus_authorizationSessionId_key" ON "ChannelPaymentStatus"("authorizationSessionId");

-- CreateIndex
CREATE INDEX "ChannelPaymentStatus_terminal_updatedAt_idx" ON "ChannelPaymentStatus"("terminal", "updatedAt");

-- CreateIndex
CREATE INDEX "ChannelPaymentStatus_userId_idx" ON "ChannelPaymentStatus"("userId");

-- AddForeignKey
ALTER TABLE "ChannelAction" ADD CONSTRAINT "ChannelAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelPaymentStatus" ADD CONSTRAINT "ChannelPaymentStatus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

