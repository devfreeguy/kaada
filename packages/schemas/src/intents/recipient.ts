import type { RecipientReference, RecipientType } from "@kaada/domain";
import { z } from "zod";

const referenceValue = z.string().trim().min(1).max(256);

const reference = <T extends RecipientType>(type: T) =>
  z.strictObject({ type: z.literal(type), value: referenceValue });

/**
 * How a sender referred to the recipient. Only the shape is checked here (non-empty text); whether
 * the value is a real username, a valid address, and so on is decided when the recipient is resolved.
 */
export const recipientReferenceSchema = z.discriminatedUnion("type", [
  reference("KAADA_USER"),
  reference("USERNAME"),
  reference("TELEGRAM_USER"),
  reference("PHONE_NUMBER"),
  reference("WALLET_ADDRESS"),
  reference("SAVED_BENEFICIARY"),
  reference("EXTERNAL_PAYMENT_ADDRESS"),
]) satisfies z.ZodType<RecipientReference>;
