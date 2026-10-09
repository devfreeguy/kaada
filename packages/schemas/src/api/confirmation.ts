import { ROUTE_STATUSES, ROUTE_STEP_TYPES } from "@kaada/domain";
import type { PaymentConfirmation } from "@kaada/domain";
import { z } from "zod";

import {
  countryCodeSchema,
  dateSchema,
  idSchema,
  jsonObjectSchema,
  moneySchema,
} from "../primitives/index.js";
import { recipientReferenceSchema } from "../intents/index.js";

const routeStepSchema = z.strictObject({
  id: idSchema,
  routeId: idSchema,
  position: z.number().int().min(0),
  type: z.enum(ROUTE_STEP_TYPES),
  input: moneySchema,
  output: moneySchema,
  providerId: idSchema.optional(),
  quoteId: idSchema.optional(),
  metadata: jsonObjectSchema.optional(),
  createdAt: dateSchema,
});

export const paymentRouteSchema = z.strictObject({
  id: idSchema,
  intentId: idSchema,
  intentRevision: z.number().int().min(1),
  status: z.enum(ROUTE_STATUSES),
  input: moneySchema,
  output: moneySchema,
  totalFee: moneySchema.optional(),
  expiresAt: dateSchema.optional(),
  steps: z.array(routeStepSchema),
  createdAt: dateSchema,
});

export const resolvedRecipientSchema = z.strictObject({
  reference: recipientReferenceSchema,
  recipientId: idSchema.optional(),
  linkedUserId: idSchema.optional(),
  displayName: z.string().max(200).optional(),
  handle: z.string().max(100).optional(),
  walletAddress: z.string().max(256).optional(),
  destinationCountry: countryCodeSchema.optional(),
  preferredAssetId: idSchema.optional(),
});

/** What the user is asked to approve, as exchanged with web or channel clients. */
export const paymentConfirmationSchema = z.strictObject({
  operation: z.enum(["SEND", "CONVERT"]),
  senderSpends: moneySchema,
  recipientReceives: moneySchema,
  recipient: resolvedRecipientSchema.optional(),
  fees: z.array(moneySchema),
  route: paymentRouteSchema,
  expiresAt: dateSchema.optional(),
}) satisfies z.ZodType<PaymentConfirmation>;
