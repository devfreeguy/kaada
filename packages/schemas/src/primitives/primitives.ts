import { defaultCountryDirectory, isHumanAmountValue, isSmallestUnitAmount } from "@kaada/domain";
import type { JsonObject, JsonValue } from "@kaada/domain";
import { z } from "zod";

export const idSchema = z.uuid();

/** Canonical smallest-unit amount: digits only, no leading zeros, no sign, no decimal point. */
export const smallestUnitAmountSchema = z
  .string()
  .refine(isSmallestUnitAmount, "must be a canonical smallest-unit integer string");

/** Canonical money. Distinct from HumanAmount: it always names a resolved asset. */
export const moneySchema = z.strictObject({
  amount: smallestUnitAmountSchema,
  assetId: idSchema,
});

/** A decimal string such as "20.50": no sign, exponent, separators, or ".5"/"1." forms. */
export const humanAmountValueSchema = z
  .string()
  .refine(isHumanAmountValue, "must be a plain decimal number such as 20.50");

/** An unresolved currency or asset label such as "USD" or "USDT". */
export const assetLabelSchema = z.string().trim().min(1).max(32);

/**
 * ISO 3166-1 alpha-2. Known country names ("Brazil") and lowercase codes are normalised to the
 * code; anything else must already be two letters.
 */
export const countryCodeSchema = z
  .string()
  .trim()
  .transform((value) => defaultCountryDirectory.normalize(value) ?? value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, "must be a two-letter country code"));

/** A Date, or an ISO 8601 timestamp with offset (what JSON carries). Always yields a Date. */
export const dateSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
]);

export const bpsSchema = z.number().int().min(0).max(10_000);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().refine(Number.isFinite, "must be finite"),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);
