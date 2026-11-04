import {
  AGENT_COMMANDS,
  AMOUNT_MODES,
  CHAT_TOPICS,
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

/**
 * RATE exists only on the wire: "what's USDT to cNGN today?" is read as a rate question and translated here into a one-unit
 * QUOTE, so the number comes from the pricing layer and never from the model.
 */
export const WIRE_TYPES = [...INTENT_TYPES, "RATE", ...AGENT_COMMANDS] as const;

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
  /** HELP only: what a conversational message is about. */
  topic: z.enum(CHAT_TOPICS).nullable(),
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

export function stripUnsupported(node: unknown): unknown {
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
  "topic",
] as const;
type Field = (typeof FIELDS)[number];

/** Which fields each intent may carry. Anything else being non-null means the model was confused. */
const ALLOWED_FIELDS: Record<IntentType | "RATE", readonly Field[]> = {
  SEND: ["recipient", "amount", "sourceAsset", "destination"],
  CONVERT: ["amount", "fromAsset", "toAsset"],
  QUOTE: ["amount", "fromAsset", "toAsset", "destination"],
  BALANCE: ["asset"],
  TRANSACTION_STATUS: ["reference"],
  HELP: ["topic"],
  UNKNOWN: [],
  // A rate question may arrive carrying an amount ("how much is 2000 pesos in naira?"). That is not a rate probe at all: it
  // is a conversion of a real amount, and rateCandidate reads it as one. Forbidding the field here would throw the amount
  // away and answer a question about one unit, which is how "2000 pesos" used to become "₦1 = ...".
  RATE: ["amount", "fromAsset", "toAsset", "destination"],
};

import { RATE_UNIT_AMOUNT } from "../../core/intents/focus.js";
/** The currency a rate is quoted from when the person names only the other side ("what is BRL today?"). */
const RATE_DEFAULT_FROM = "USD";

const isCommand = (type: WireInterpretation["type"]): type is (typeof AGENT_COMMANDS)[number] =>
  (AGENT_COMMANDS as readonly string[]).includes(type);

function text(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** A number written as a negative: "-50", "- 50", "−50" (the minus sign people's keyboards produce). */
const NEGATIVE_AMOUNT = /^[-−–—]\s*[\d.,]+[km]?$/i;

/**
 * Normalises the way a number was written ("10k", "10,000"); refuses ambiguity rather than guessing.
 *
 * A negative number is refused separately from an unreadable one. Both are refusals, but they are not the same refusal:
 * "send -50 USDT to Daniel" is a perfectly clear sentence, and answering it with "I didn't understand that" is both untrue
 * and useless, because it asks the person to rephrase something that needed no rephrasing. The amount is the problem, and
 * saying so is the only reply that tells them what to change.
 */
function amountValue(raw: string): string {
  if (NEGATIVE_AMOUNT.test(raw.trim())) throw new InterpreterOutputError("NEGATIVE_AMOUNT");
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
  if (wire.type === "RATE") return rateCandidate(wire);

  const intent: Record<string, unknown> = { type: wire.type };
  const topic = wire.topic;
  if (topic !== null) intent["topic"] = topic;

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

/**
 * A rate question as a QUOTE. The target must be named (an asset, a currency or a country); without one the question is
 * conversational ("which rate?") and nothing is priced. The pricing layer, not the model, supplies every number.
 *
 * Size matters here. "What's naira to pesos?" asks the PRICE OF ONE UNIT and is answered as a rate, so it is probed with
 * RATE_UNIT_AMOUNT. "How much is 2000 pesos in naira?" names a real amount and is a conversion of that amount, answered with
 * the converted figure. Both reach the model as type RATE, so the amount it reports is what tells them apart.
 */
function rateCandidate(wire: WireInterpretation): unknown {
  const from = text(wire.fromAsset);
  const to = text(wire.toAsset);
  const stated = text(wire.amount?.value ?? null);
  const destination = {
    ...(text(wire.destination?.country ?? null) && {
      country: text(wire.destination?.country ?? null),
    }),
    ...(text(wire.destination?.currency ?? null) && {
      currency: text(wire.destination?.currency ?? null),
    }),
    ...(text(wire.destination?.asset ?? null) && { asset: text(wire.destination?.asset ?? null) }),
  };
  if (to === undefined && Object.keys(destination).length === 0) {
    return { kind: "INTENT", intent: { type: "HELP", topic: "RATE_GENERAL" } };
  }
  // The currency the amount is in, when one was named, is the side being converted FROM: "2000 pesos in naira" is 2000 of
  // the pesos. fromAsset is used when the model filled only that.
  const source = text(wire.amount?.currencyOrAsset ?? null) ?? from ?? RATE_DEFAULT_FROM;
  return {
    kind: "INTENT",
    intent: {
      type: "QUOTE",
      amount: {
        value: stated === undefined ? RATE_UNIT_AMOUNT : amountValue(stated),
        currencyOrAsset: source,
        mode: "EXACT_INPUT",
      },
      fromAsset: source,
      // Only a question about ONE unit is worded as a rate. With a real amount the person asked what that amount is worth,
      // so the answer is the converted figure. The model asked for type RATE; it cannot set this field itself.
      ...(stated === undefined && { rateOnly: true }),
      ...(to !== undefined && { toAsset: to }),
      ...(Object.keys(destination).length > 0 && { destination }),
    },
  };
}
