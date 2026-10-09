import { z } from "zod";

import { idSchema } from "../primitives/index.js";

/**
 * Body of the internal development endpoint. It carries only what a user typed, never an
 * interpreted intent: interpretation always happens server-side.
 */
export const agentMessageRequestSchema = z.strictObject({
  userId: idSchema.optional(),
  conversationId: idSchema.optional(),
  content: z.string().trim().min(1).max(4000),
});
