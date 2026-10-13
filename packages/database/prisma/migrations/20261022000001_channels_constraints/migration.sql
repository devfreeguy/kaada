-- A webhook event id is never empty, and a PROCESSED event says when.
ALTER TABLE "ChannelInboundEvent" ADD CONSTRAINT "ChannelInboundEvent_wellformed" CHECK (
  length("externalEventId") BETWEEN 1 AND 128
  AND ("status" <> 'PROCESSED' OR "processedAt" IS NOT NULL)
);

-- A button handle is the opaque 22-character handle (16 random bytes, base64url); Telegram callback_data is capped at 64 bytes.
ALTER TABLE "ChannelAction" ADD CONSTRAINT "ChannelAction_wellformed" CHECK (
  "handle" ~ '^[A-Za-z0-9_-]{22}$'
  AND "expiresAt" > "createdAt"
  AND length("externalUserId") BETWEEN 1 AND 64
  AND ("reusable" = false OR "usedAt" IS NULL)
);

-- One status-message record per authorization session, always naming where the person was last told.
ALTER TABLE "ChannelPaymentStatus" ADD CONSTRAINT "ChannelPaymentStatus_wellformed" CHECK (
  length("lastState") BETWEEN 1 AND 64
  AND length("externalConversationId") BETWEEN 1 AND 64
);
