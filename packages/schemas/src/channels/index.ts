import { CHANNEL_TYPES } from "@kaada/domain";
import type { IncomingMessage } from "@kaada/domain";
import { z } from "zod";

import { dateSchema } from "../primitives/index.js";

/** A channel message after the adapter has parsed the raw webhook payload. */
export const incomingMessageSchema = z.strictObject({
  channel: z.enum(CHANNEL_TYPES),
  externalConversationId: z.string().min(1).max(256),
  externalMessageId: z.string().min(1).max(256).optional(),
  externalUserId: z.string().min(1).max(256),
  username: z.string().min(1).max(256).optional(),
  text: z.string().max(10_000),
  receivedAt: dateSchema,
}) satisfies z.ZodType<IncomingMessage>;
