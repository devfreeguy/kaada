import {
  AGENT_COMMANDS,
  AMOUNT_MODES,
  INTENT_TYPES,
  RECIPIENT_TYPES,
  normalizeSpokenAmount,
} from "@kaada/domain";
import type { IntentType } from "@kaada/domain";
import { z } from "zod";

import { InterpreterOutputError } from "../../core/agent/interpreter.js";

/*
 * The wire format is what the model is asked to produce. Groq's strict structured output needs every
 * property present, so optional values are expressed as null. It is a flat superset of all intents
 * plus the two conversation commands, which keeps the schema small and the model's job simple.
 *
 * The wire format is NOT trusted and is not a second source of truth. It is translated into the
 * shape of the existing Interpretation and then validated by interpretationSchema, which alone
 * decides what is a valid intent.
 */

/*
 * Constraints (max slippage, route preference, max fee) are deliberately not part of the model-facing
 * schema yet: nothing consumes them until routing exists, and they cost schema tokens on every call.
 * The domain and the app schema still support them; expose them here when routing needs them.
 */

export const WIRE_TYPES = [...INTENT_TYPES, ...AGENT_COMMANDS] as const;

const maybeText = z.string().nullable();
// "value" and "currencyOrAsset" may each be unknown ("send 20 to Daniel" has no currency). Allowing
// null here, rather than forcing the model to invent a string or drop the whole object, is what keeps
// Groq's strict validation from rejecting an honest answer.
export const wireInterpretationSchema = z.strictObject({
  type: z.enum(WIRE_TYPES),
  recipient: z.strictObject({ type: z.enum(RECIPIENT_TYPES), value: z.string() }).nullable(),
  amount: z
    .strictObject({
      value: z.string().nullable(),
      currencyOrAsset: maybeText,
      mode: z.enum(AMOUNT_MODES).nullable(),
    })
    .nullable(),
  sourceAsset: maybeText,
  fromAsset: maybeText,
  toAsset: maybeText,
  asset: maybeText,
  reference: maybeText,
  destination: z
    .strictObject({ country: maybeText, currency: maybeText, asset: maybeText })
    .nullable(),
});

export type WireInterpretation = z.infer<typeof wireInterpretationSchema>;

/** Keywords Groq's constrained decoding does not support; validation of these happens afterwards. */
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "default",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node !== null && typeof node === "object") {
    const entries: [string, unknown][] = Object.entries(node);
    return Object.fromEntries(
      entries
        .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
        .map(([key, value]) => [key, stripUnsupported(value)]),
    );
  }
  return node;
}

/** The JSON Schema sent to Groq, generated from the Zod wire schema so the two cannot drift. */
export function wireJsonSchema(): Record<string, unknown> {
  const generated: unknown = JSON.parse(JSON.stringify(z.toJSONSchema(wireInterpretationSchema)));
  const stripped = stripUnsupported(generated);
  if (stripped === null || typeof stripped !== "object" || Array.isArray(stripped)) {
    throw new Error("unexpected JSON schema shape");
  }
  return Object.fromEntries(Object.entries(stripped));
}

/**
 * Lists the ways a JSON Schema breaks Groq strict mode's rules (every property required, no extra
 * properties, nothing outside the supported keywords). Empty means compliant. Used by tests.
 */
export function strictSchemaViolations(node: unknown, path = "#"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => strictSchemaViolations(item, `${path}[${index}]`));
  }
  if (node === null || typeof node !== "object") return [];

  const record: Record<string, unknown> = Object.fromEntries(Object.entries(node));
  const found: string[] = [];
  for (const keyword of Object.keys(record)) {
    if (UNSUPPORTED_KEYWORDS.has(keyword)) found.push(`${path}: unsupported keyword ${keyword}`);
  }
  const properties = record["properties"];
  if (record["type"] === "object" && properties !== null && typeof properties === "object") {
    if (record["additionalProperties"] !== false) found.push(`${path}: additionalProperties`);
    const keys = Object.keys(properties).sort();
    const requiredList: unknown = record["required"];
    const required = Array.isArray(requiredList)
      ? requiredList.filter((name): name is string => typeof name === "string").sort()
      : [];
    if (JSON.stringify(keys) !== JSON.stringify(required)) found.push(`${path}: required`);
  }
  for (const [key, value] of Object.entries(record)) {
    found.push(...strictSchemaViolations(value, `${path}/${key}`));
  }
  return found;
}

const FIELDS = [
  "recipient",
  "amount",
  "sourceAsset",
  "fromAsset",
  "toAsset",
  "asset",
  "reference",
  "destination",
] as const;
type Field = (typeof FIELDS)[number];

/** Which fields each intent may carry. Anything else being non-null means the model was confused. */
const ALLOWED_FIELDS: Record<IntentType, readonly Field[]> = {
  SEND: ["recipient", "amount", "sourceAsset", "destination"],
  CONVERT: ["amount", "fromAsset", "toAsset"],
  QUOTE: ["amount", "fromAsset", "toAsset", "destination"],
  BALANCE: ["asset"],
  TRANSACTION_STATUS: ["reference"],
  HELP: [],
  UNKNOWN: [],
};

const isCommand = (type: WireInterpretation["type"]): type is (typeof AGENT_COMMANDS)[number] =>
  (AGENT_COMMANDS as readonly string[]).includes(type);

function text(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Normalises the way a number was written ("10k", "10,000"); refuses ambiguity rather than guessing. */
function amountValue(raw: string): string {
  const value = normalizeSpokenAmount(raw);
  if (value === undefined) throw new InterpreterOutputError("AMBIGUOUS_AMOUNT");
  return value;
}

/**
 * Translates a parsed wire object into the candidate Interpretation (still unvalidated). Null means
 * "not stated" and is dropped. Throws InterpreterOutputError for fields that do not belong to the
 * type and for numbers that cannot be read unambiguously.
 */
export function wireToCandidate(wire: WireInterpretation): unknown {
  const allowed: readonly Field[] = isCommand(wire.type) ? [] : ALLOWED_FIELDS[wire.type];
  for (const field of FIELDS) {
    if (wire[field] !== null && !allowed.includes(field)) {
      throw new InterpreterOutputError(`UNEXPECTED_FIELD_${field}`);
    }
  }
  if (isCommand(wire.type)) return { kind: "COMMAND", command: wire.type };

  const intent: Record<string, unknown> = { type: wire.type };

  if (wire.recipient) intent["recipient"] = wire.recipient;
  // No number means there is no amount to record. A number with no currency is kept as such: the
  // application asks which currency it is in.
  const amountText = text(wire.amount?.value ?? null);
  if (wire.amount && amountText !== undefined) {
    const currency = text(wire.amount.currencyOrAsset);
    intent["amount"] = {
      value: amountValue(amountText),
      ...(currency !== undefined && { currencyOrAsset: currency }),
      ...(wire.amount.mode && { mode: wire.amount.mode }),
    };
  }
  for (const field of ["sourceAsset", "fromAsset", "toAsset", "asset", "reference"] as const) {
    const value = text(wire[field]);
    if (value !== undefined) intent[field] = value;
  }

  if (wire.destination) {
    const destination = {
      ...(text(wire.destination.country) && { country: text(wire.destination.country) }),
      ...(text(wire.destination.currency) && { currency: text(wire.destination.currency) }),
      ...(text(wire.destination.asset) && { asset: text(wire.destination.asset) }),
    };
    if (Object.keys(destination).length > 0) intent["destination"] = destination;
  }

  return { kind: "INTENT", intent };
}
