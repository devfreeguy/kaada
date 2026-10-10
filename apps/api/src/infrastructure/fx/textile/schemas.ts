import { z } from "zod";

/*
 * Textile v2 RFQ response schemas. Built ONLY from fields documented at
 * https://fx-docs.textilecredit.com/api/v2/rfq.html, https://fx-docs.textilecredit.com/api/v2/errors.html
 * and https://fx-docs.textilecredit.com/openapi-v2.json. Anything not listed there is not read.
 *
 * Textile is untrusted external input: these schemas check shape only. Semantic checks (does the
 * amount match what was asked, is the chain right) happen in the provider.
 *
 * Objects are `looseObject` so an added field does not break us, but nothing outside these schemas
 * is ever copied into a Kaada type.
 */

/** Atomic-unit amounts are base-10 integer strings (documented). Canonical: no sign, no leading zeros. */
export const atomicAmountSchema = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/, "not a canonical atomic-unit integer");

/** The documented error envelope: `{ error: { code, message, request_id, details? } }`. */
export const textileErrorSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string().optional(),
    request_id: z.string().optional(),
    details: z
      .looseObject({
        // Documented enum, e.g. corridor_unavailable, insufficient_funds, proof_of_control_required.
        reason: z.string().optional(),
      })
      .optional(),
  }),
});

/** Documented reasons a request can end with no quote (HTTP 200, status "no_quote"). */
const noQuoteSchema = z.looseObject({
  status: z.literal("no_quote"),
  // no_makers_online | no_restricted_liquidity | no_valid_quote (documented). Kept as text so a new
  // reason is reported rather than rejected.
  reason: z.string().optional(),
  // TODO(live): retryAfterMs / reservedUntil are documented but not used until retries are tuned live.
  retryAfterMs: z.number().int().nonnegative().optional(),
});

/**
 * POST /rfq/preview: an indicative price. Documented fields: status, sellAmount, buyAmount,
 * feeAmount, takerPays, rateRay. There is NO quote id and NO expiry on a preview.
 */
export const previewResponseSchema = z.looseObject({
  data: z.discriminatedUnion("status", [
    z.looseObject({
      status: z.literal("preview"),
      sellAmount: atomicAmountSchema,
      buyAmount: atomicAmountSchema,
      feeAmount: atomicAmountSchema,
      takerPays: atomicAmountSchema,
      // Documented as RAY-scaled (1e27) but its unit is not defined for quotes; never used for math.
      rateRay: z.string().optional(),
    }),
    noQuoteSchema,
  ]),
});

/** A value Textile sends as a decimal string, a hex string or a number, kept as a decimal string. */
const nativeValueSchema = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform((value, ctx) => {
    try {
      return BigInt(value).toString();
    } catch {
      ctx.addIssue({ code: "custom", message: "not an integer" });
      return z.NEVER;
    }
  });

/** The documented fields of an unsigned transaction: to, data, value, chainId (no gas field). */
const unsignedTransactionSchema = z.looseObject({
  to: z.string().min(1),
  data: z.string().min(1),
  value: nativeValueSchema,
  chainId: z.number().int(),
});

/**
 * POST /rfq/request: a firm quote bound to a `taker` wallet. Only the fields Kaada reads are declared.
 * `claimToken` is returned ONCE and authorises submit/cancel/status: it is parsed here so it can be
 * encrypted and kept, and is a secret from this point on (the provider adapter wraps it in a
 * SecretValue). The signed orders and encoded order are deliberately NOT parsed.
 */
export const firmResponseSchema = z.looseObject({
  data: z.discriminatedUnion("status", [
    z.looseObject({
      status: z.literal("quoted"),
      rfqId: z.string().min(1),
      claimToken: z.string().min(1),
      quote: z.looseObject({
        sellAmount: atomicAmountSchema,
        buyAmount: atomicAmountSchema,
        feeAmount: atomicAmountSchema,
        takerPays: atomicAmountSchema,
        // The accept cutoff: "treat as your deadline" (documented).
        expiresAt: z.iso.datetime(),
        orderDeadline: z.iso.datetime().optional(),
        latestOrderDeadline: z.iso.datetime().optional(),
        // The contract the order settles through, to which the sell token is approved (documented).
        reactor: z.string().min(1),
        // Documented as possibly different from the reactor; absent in the common case.
        spender: z.string().min(1).optional(),
        taker: z.string().min(1),
      }),
      transactions: z.looseObject({
        approval: unsignedTransactionSchema,
        swap: unsignedTransactionSchema,
      }),
    }),
    noQuoteSchema,
  ]),
});

export type TextileErrorBody = z.infer<typeof textileErrorSchema>;
export type PreviewResponse = z.infer<typeof previewResponseSchema>;
export type FirmResponse = z.infer<typeof firmResponseSchema>;
