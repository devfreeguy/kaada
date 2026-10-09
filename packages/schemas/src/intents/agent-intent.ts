import { AMOUNT_MODES, MISSING_FIELDS, ROUTE_PREFERENCES } from "@kaada/domain";
import type {
  AgentIntent,
  BalanceIntent,
  ConvertIntent,
  HelpIntent,
  QuoteIntent,
  SendIntent,
  TransactionStatusIntent,
  UnknownIntent,
} from "@kaada/domain";
import { z } from "zod";

import {
  assetLabelSchema,
  bpsSchema,
  countryCodeSchema,
  humanAmountValueSchema,
} from "../primitives/index.js";
import { recipientReferenceSchema } from "./recipient.js";

/*
 * Strict schemas for what the language stage may return. Every field except `type` is optional
 * because users leave things out, and unknown keys are rejected so a drifting model fails loudly.
 */

const text = z.string().trim().min(1).max(500);

export const humanAmountSchema = z.strictObject({
  value: humanAmountValueSchema,
  currencyOrAsset: assetLabelSchema,
});

/** A number, usually with its currency. The currency is optional: it is asked for, never guessed. */
export const intentAmountSchema = z.strictObject({
  value: humanAmountValueSchema,
  currencyOrAsset: assetLabelSchema.optional(),
  mode: z.enum(AMOUNT_MODES).optional(),
});

export const destinationSchema = z.strictObject({
  country: countryCodeSchema.optional(),
  currency: assetLabelSchema.optional(),
  asset: assetLabelSchema.optional(),
});

export const paymentConstraintsSchema = z.strictObject({
  maxSlippageBps: bpsSchema.optional(),
  routePreference: z.enum(ROUTE_PREFERENCES).optional(),
  maxFee: humanAmountSchema.optional(),
});

export const sendIntentSchema = z.strictObject({
  type: z.literal("SEND"),
  recipient: recipientReferenceSchema.optional(),
  amount: intentAmountSchema.optional(),
  sourceAsset: assetLabelSchema.optional(),
  destination: destinationSchema.optional(),
  constraints: paymentConstraintsSchema.optional(),
}) satisfies z.ZodType<SendIntent>;

export const convertIntentSchema = z.strictObject({
  type: z.literal("CONVERT"),
  amount: intentAmountSchema.optional(),
  fromAsset: assetLabelSchema.optional(),
  toAsset: assetLabelSchema.optional(),
  constraints: paymentConstraintsSchema.optional(),
}) satisfies z.ZodType<ConvertIntent>;

export const quoteIntentSchema = z.strictObject({
  type: z.literal("QUOTE"),
  amount: intentAmountSchema.optional(),
  fromAsset: assetLabelSchema.optional(),
  toAsset: assetLabelSchema.optional(),
  destination: destinationSchema.optional(),
  constraints: paymentConstraintsSchema.optional(),
}) satisfies z.ZodType<QuoteIntent>;

export const balanceIntentSchema = z.strictObject({
  type: z.literal("BALANCE"),
  asset: assetLabelSchema.optional(),
}) satisfies z.ZodType<BalanceIntent>;

export const transactionStatusIntentSchema = z.strictObject({
  type: z.literal("TRANSACTION_STATUS"),
  reference: text.optional(),
}) satisfies z.ZodType<TransactionStatusIntent>;

export const helpIntentSchema = z.strictObject({
  type: z.literal("HELP"),
  topic: text.optional(),
}) satisfies z.ZodType<HelpIntent>;

export const unknownIntentSchema = z.strictObject({
  type: z.literal("UNKNOWN"),
  reason: text.optional(),
}) satisfies z.ZodType<UnknownIntent>;

/** Any intent the agent can extract, discriminated by `type`. Incomplete intents are valid. */
export const agentIntentSchema = z.discriminatedUnion("type", [
  sendIntentSchema,
  convertIntentSchema,
  quoteIntentSchema,
  balanceIntentSchema,
  transactionStatusIntentSchema,
  helpIntentSchema,
  unknownIntentSchema,
]) satisfies z.ZodType<AgentIntent>;

export const missingFieldsSchema = z.array(z.enum(MISSING_FIELDS));
