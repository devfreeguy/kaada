import { AMOUNT_MODES, ROUTE_PREFERENCES, isKaadaError, validateQuoteRequest } from "@kaada/domain";
import type { QuoteRequest } from "@kaada/domain";
import { z } from "zod";

import { bpsSchema, idSchema, moneySchema } from "../primitives/index.js";

export const quoteConstraintsSchema = z.strictObject({
  maxSlippageBps: bpsSchema.optional(),
  routePreference: z.enum(ROUTE_PREFERENCES).optional(),
});

/**
 * A resolved quote request. `amount` is the fixed side: EXACT_INPUT means it is denominated in
 * inputAssetId, EXACT_OUTPUT in outputAssetId. The domain rule is reused, not re-implemented.
 */
export const quoteRequestSchema = z
  .strictObject({
    userId: idSchema,
    inputAssetId: idSchema,
    outputAssetId: idSchema,
    amount: moneySchema,
    mode: z.enum(AMOUNT_MODES),
    constraints: quoteConstraintsSchema.optional(),
  })
  .superRefine((request, ctx) => {
    try {
      validateQuoteRequest(request);
    } catch (error) {
      if (!isKaadaError(error)) throw error;
      ctx.addIssue({ code: "custom", message: error.message, path: ["amount"] });
    }
  }) satisfies z.ZodType<QuoteRequest>;
