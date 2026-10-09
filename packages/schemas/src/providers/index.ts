import type { FxQuote } from "@kaada/domain";
import { z } from "zod";

import {
  bpsSchema,
  dateSchema,
  idSchema,
  jsonObjectSchema,
  moneySchema,
} from "../primitives/index.js";

/**
 * The normalised quote an FX adapter must return. Validating it at the adapter boundary keeps
 * malformed provider data (non-integer amounts, bad ids) from entering the domain.
 */
export const fxQuoteSchema = z.strictObject({
  id: idSchema,
  provider: z.string().trim().min(1).max(64),
  input: moneySchema,
  output: moneySchema,
  fee: moneySchema.optional(),
  slippageBps: bpsSchema.optional(),
  expiresAt: dateSchema.optional(),
  providerQuoteId: z.string().min(1).max(256).optional(),
  metadata: jsonObjectSchema.optional(),
}) satisfies z.ZodType<FxQuote>;
