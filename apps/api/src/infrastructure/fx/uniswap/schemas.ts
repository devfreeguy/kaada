import { z } from "zod";

/*
 * Uniswap Trading API response schemas.
 *
 * Built from what the API ACTUALLY RETURNED, not from the published reference: that reference redirects to a 404 and
 * llms-full.txt describes the endpoints without field-level schemas. Every field below was observed on a live call to
 * https://trade-api.gateway.uniswap.org/v1 for cNGN -> wARS on Celo.
 *
 * Uniswap is untrusted external input: these schemas check SHAPE only. Whether the amounts match what was asked, and
 * whether the chain is the one we meant, is decided in the provider.
 *
 * Objects are `looseObject` so an added field does not break us, and nothing outside these schemas is ever copied into
 * a Kaada type.
 */

/** Amounts come back as base-10 integer strings in the token's smallest unit. */
export const atomicAmountSchema = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/, "not a canonical atomic-unit integer");

/** 0x-prefixed, 20 bytes. Compared only after lowercasing: the API mixes checksummed and plain forms. */
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not an address");

const hexDataSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "not hex data");

/** A quantity the API writes as hex ("0x00") where amounts elsewhere are decimal. */
const hexQuantitySchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "not a hex quantity");

/** One side of the trade. `maximumAmount` appears on input, `minimumAmount` on output. */
const sideSchema = z.looseObject({
  amount: atomicAmountSchema,
  token: addressSchema,
  recipient: addressSchema.optional(),
  minimumAmount: atomicAmountSchema.optional(),
  maximumAmount: atomicAmountSchema.optional(),
});

/**
 * The quote. `slippage` is a PERCENT (2.5 means 2.5%), which matters: Kaada counts slippage in basis points
 * everywhere else, so it is converted once, in the provider, rather than carried in two units.
 */
export const quoteSchema = z.looseObject({
  chainId: z.number(),
  swapper: addressSchema,
  tradeType: z.enum(["EXACT_INPUT", "EXACT_OUTPUT"]),
  input: sideSchema,
  output: sideSchema,
  slippage: z.number().optional(),
  priceImpact: z.number().optional(),
  gasFee: atomicAmountSchema.optional(),
  gasFeeUSD: z.string().optional(),
  quoteId: z.string().optional(),
  routeString: z.string().optional(),
  blockNumber: z.string().optional(),
});

export const quoteResponseSchema = z.looseObject({
  requestId: z.string(),
  /** CLASSIC is an on-chain AMM route. Anything else (UniswapX, bridges) is refused by the provider. */
  routing: z.string(),
  isTokenApprovalApplicable: z.boolean().optional(),
  quote: quoteSchema,
});

/** An unsigned transaction, exactly as the API returns it. `value` is hex here, decimal in Kaada. */
export const transactionSchema = z.looseObject({
  to: addressSchema,
  from: addressSchema.optional(),
  data: hexDataSchema,
  value: hexQuantitySchema,
  chainId: z.number(),
  gasLimit: z.string().optional(),
});

export const swapResponseSchema = z.looseObject({
  requestId: z.string(),
  swap: transactionSchema,
});

/** `approval` is null when the allowance is already in place; `cancel` is the reset some tokens need first. */
export const approvalResponseSchema = z.looseObject({
  requestId: z.string(),
  approval: transactionSchema.nullable(),
  cancel: transactionSchema.nullable().optional(),
});

/** The documented error envelope: `{ errorCode, detail }`. */
export const uniswapErrorSchema = z.looseObject({
  errorCode: z.string().optional(),
  detail: z.string().optional(),
});

export type UniswapQuote = z.infer<typeof quoteSchema>;
export type UniswapQuoteResponse = z.infer<typeof quoteResponseSchema>;
export type UniswapSwapResponse = z.infer<typeof swapResponseSchema>;
export type UniswapApprovalResponse = z.infer<typeof approvalResponseSchema>;
export type UniswapTransaction = z.infer<typeof transactionSchema>;
