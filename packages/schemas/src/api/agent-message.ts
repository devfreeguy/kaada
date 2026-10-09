import { z } from "zod";

import { idSchema } from "../primitives/index.js";

/**
 * Body of the internal development endpoint: either what a person typed, or the id of an option they
 * picked. It never carries an interpreted intent or a resolved value: interpretation happens
 * server-side, and a picked option is looked up on the server by its opaque id.
 */
export const agentMessageRequestSchema = z.union([
  z.strictObject({
    userId: idSchema.optional(),
    conversationId: idSchema.optional(),
    content: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    userId: idSchema,
    conversationId: idSchema,
    optionId: z.string().trim().min(1).max(100),
  }),
]);
