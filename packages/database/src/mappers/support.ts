import { createMoney } from "@kaada/domain";
import type { JsonObject, JsonValue, Money } from "@kaada/domain";
import { jsonObjectSchema, jsonValueSchema } from "@kaada/schemas";
import type { z } from "zod";

import type { Prisma } from "../generated/prisma/client.js";

/** A stored row that cannot be represented as a valid domain object (corrupt or out-of-date data). */
export class DataIntegrityError extends Error {
  override readonly name = "DataIntegrityError";
}

/** `{ key: value }` when the value is present, `{}` for null/undefined. Keeps optional props exact. */
export function maybe<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** Parses a JSON column with a schema, reporting failures as data integrity problems. */
export function parseColumn<S extends z.ZodType>(
  schema: S,
  value: unknown,
  label: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DataIntegrityError(`${label} is not valid: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.data;
}

/** An optional JSON object column: NULL becomes undefined, anything else must be a JSON object. */
export function readJsonObject(
  value: Prisma.JsonValue | null,
  label: string,
): JsonObject | undefined {
  return value === null ? undefined : parseColumn(jsonObjectSchema, value, label);
}

/** A required JSON object column that defaults to {}. */
export function readJsonObjectOrEmpty(value: Prisma.JsonValue, label: string): JsonObject {
  return parseColumn(jsonObjectSchema, value, label);
}

/** Any JSON value; NULL becomes undefined. */
export function readJsonValue(
  value: Prisma.JsonValue | null,
  label: string,
): JsonValue | undefined {
  return value === null ? undefined : parseColumn(jsonValueSchema, value, label);
}

/**
 * Turns plain domain data into JSON that is safe to store: round-trips through JSON (so Dates become
 * ISO strings and undefined keys vanish) and validates the result. Rejects bigint, functions and
 * non-finite numbers rather than silently coercing them.
 */
export function toStorableJson(value: unknown, label: string): JsonValue {
  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(value);
  } catch (error) {
    throw new DataIntegrityError(`${label} cannot be serialised to JSON`, { cause: error });
  }
  const reparsed: unknown = JSON.parse(serialised ?? "null");
  return parseColumn(jsonValueSchema, reparsed, label);
}

/** A Prisma Json input for an optional value: undefined/null leave the column NULL. */
export function jsonInput(value: unknown, label: string): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  const json = toStorableJson(value, label);
  return json === null ? undefined : json;
}

/** Money from a nullable amount/asset pair; both must be present or both absent. */
export function moneyFromColumns(
  amount: string | null,
  assetId: string | null,
  label: string,
): Money | undefined {
  if (amount === null && assetId === null) return undefined;
  if (amount === null || assetId === null) {
    throw new DataIntegrityError(
      `${label} has an amount without an asset, or an asset without an amount`,
    );
  }
  return createMoney(amount, assetId);
}
