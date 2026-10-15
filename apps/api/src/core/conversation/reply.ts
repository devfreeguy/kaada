import { z } from "zod";

import { isSuggestionId } from "./capabilities.js";
import type { CapabilityFlags, SuggestionId } from "./capabilities.js";
import type { ReplyParts } from "./fallbacks.js";
import type { PresentationMode, ResponseState } from "./states.js";

/**
 * The ONLY shape accepted from the presentation model. Every field is optional text (null when unused) plus the ids of
 * suggested actions. There is no field for amounts, recipients, statuses or buttons: those come from the application.
 * Strict mode needs every property present, hence the nulls.
 */
export const replySchema = z.strictObject({
  acknowledgement: z.string().nullable(),
  body: z.string().nullable(),
  question: z.string().nullable(),
  closing: z.string().nullable(),
  suggestedActionIds: z.array(z.string()),
});
export type ModelReply = z.infer<typeof replySchema>;

const MAX_FIELD = { acknowledgement: 200, body: 360, question: 220, closing: 160 } as const;
const MAX_TOTAL = 520;
const MAX_EMOJI = 2;

/** Words that would let generated text claim an outcome. Outcomes are the application's to report. */
const OUTCOME_CLAIM =
  /\b(succeed(?:ed|s)?|successful(?:ly)?|completed?|went through|(?:has|have|had|was|were|been|is) sent|sent (?:it|your|the|him|her|them)|authori[sz]ed|approved|confirmed|failed|failure|refunded|declined)\b/i;
const SECRETS = /\b(pin|passcode|password|recovery code|private key|seed phrase|secret key)\b/i;
/** The one place the model may say "PIN": to point at where it is set up. It still may not ask for one. */
const MAY_NAME_PIN: ReadonlySet<ResponseState> = new Set([
  "ONBOARDING_PIN_NEEDED",
  "ONBOARDING_RECOVERY_NEEDED",
]);
/**
 * Onboarding replies must actually name the step the application says is next, so a model cannot skip or swap a step (it may
 * only phrase it). Anything that does not is replaced by the fixed wording.
 */
const MUST_MENTION: Partial<Record<ResponseState, RegExp>> = {
  ONBOARDING_PIN_NEEDED: /\bPIN\b/i,
  ONBOARDING_RECOVERY_NEEDED: /\brecovery\b/i,
};

/** Where a trusted "all done" is true, so the model may say so. */
const MAY_CELEBRATE: ReadonlySet<ResponseState> = new Set(["ONBOARDING_COMPLETE"]);
const MARKUP = /https?:\/\/|www\.|\]\(|`|<\/?[a-z]|\{\{|\}\}/i;
const LEAKS = /\b(system prompt|trusted[_ ]state|user[_ ]message|my instructions|json)\b/i;
/** Features Kaada does not have: never to be promised, whatever the model "remembers" from elsewhere. */
const UNBUILT =
  /\b(swaps?|swapping|transaction history|recent transactions?|invest\w*|loans?|stak(?:e|ing)|savings|crypto cards?|invite friends?)\b/i;

/** States where the application renders the question or the block itself: the model contributes one short lead and nothing else. */
const LEAD_ONLY_STATES: ReadonlySet<ResponseState> = new Set([
  "AMBIGUOUS_RECIPIENT",
  "AMBIGUOUS_ASSET",
  "PAYMENT_CORRECTION",
  "BALANCE_QUERY",
]);

/** A reply that says something is on show ("the current rate", "your balance is") when the application showed nothing there. */
const PHANTOM_BLOCK =
  /\b(?:current|latest)\s+(?:rates?|balances?)\b|\byour balance is\b|\bhere(?:'s|’s| is| are)\s+(?:the |your )?(?:rate|balance)/i;

const NUMBER = /\d[\d.,]*/g;
const numbersIn = (text: string): string[] =>
  (text.match(NUMBER) ?? []).map((value) => value.replace(/[.,]+$/, ""));

export interface ValidateContext {
  mode: Exclude<PresentationMode, "DETERMINISTIC">;
  state: ResponseState;
  flags: CapabilityFlags;
  /** Suggestion ids the server allows for this reply. */
  allowedSuggestions: readonly SuggestionId[];
  /** Numbers the reply may repeat: only those inside trusted known facts. */
  knownFactValues: readonly string[];
  needsQuestion: boolean;
}

export type Validation =
  { ok: true; parts: ReplyParts; suggestions: SuggestionId[] } | { ok: false; reason: string };

const fail = (reason: string): Validation => ({ ok: false, reason });

/**
 * Parses and checks a model reply. Anything outside the contract fails the WHOLE reply (the caller then uses the deterministic
 * wording): oversized text, markup, secrets, outcome claims, numbers that are not trusted facts, features that do not exist,
 * emoji floods, or no hand-back question where one is required. Suggested ids outside the allowlist are dropped.
 */
export function validateReply(raw: unknown, context: ValidateContext): Validation {
  const parsed = replySchema.safeParse(raw);
  if (!parsed.success) return fail("SCHEMA");
  const reply = parsed.data;

  const clean = (value: string | null, max: number): string | undefined => {
    const text = value?.replace(/\s+/g, " ").trim();
    return text ? (text.length <= max ? text : undefined) : undefined;
  };
  const acknowledgement = clean(reply.acknowledgement, MAX_FIELD.acknowledgement);
  const body = clean(reply.body, MAX_FIELD.body);
  const question = clean(reply.question, MAX_FIELD.question);
  const closing = clean(reply.closing, MAX_FIELD.closing);
  // A field that was present but too long becomes undefined above; treat that as a failure rather than silently trimming it.
  for (const [field, value, max] of [
    ["acknowledgement", reply.acknowledgement, MAX_FIELD.acknowledgement],
    ["body", reply.body, MAX_FIELD.body],
    ["question", reply.question, MAX_FIELD.question],
    ["closing", reply.closing, MAX_FIELD.closing],
  ] as const) {
    if (value && value.trim().length > max) return fail(`TOO_LONG_${field}`);
  }

  // Wrapped replies only phrase a lead and a closing around the application's block; some states allow only the lead.
  const leadOnly = LEAD_ONLY_STATES.has(context.state);
  const wrapped: ReplyParts = {
    ...(acknowledgement && { acknowledgement }),
    ...(!leadOnly && (closing ?? question) && { closing: (closing ?? question) as string }),
  };
  const parts: ReplyParts =
    context.mode === "MODEL_WRAPPED"
      ? wrapped
      : {
          ...(acknowledgement && { acknowledgement }),
          ...(body && { body }),
          ...(question && { question }),
          ...(closing && { closing }),
        };

  const text = Object.values(parts).join(" ");
  if (text.length === 0) return fail("EMPTY");
  if (text.length > MAX_TOTAL) return fail("TOO_LONG");
  const refused = screenText(text, context);
  if (refused) return fail(refused);

  if (context.needsQuestion && !text.includes("?")) return fail("NO_QUESTION");
  const required = MUST_MENTION[context.state];
  if (required && !required.test(text)) return fail("MISSING_STEP");

  const allowed = new Set<string>(context.allowedSuggestions);
  const suggestions = reply.suggestedActionIds.filter(
    (id): id is SuggestionId => isSuggestionId(id) && allowed.has(id),
  );
  return { ok: true, parts, suggestions: [...new Set(suggestions)] };
}

/**
 * The checks every piece of generated text must pass, in one place. They run on the FINISHED reply, and they also run on the
 * text streamed so far (up to the last complete word), so a draft never shows what the final reply would have been refused for:
 * markup, secrets, claims of an outcome, a figure that is not a trusted fact, a feature that does not exist, an emoji flood.
 * Returns the reason it is refused, or undefined when the text is acceptable.
 */
export function screenText(
  text: string,
  context: Pick<ValidateContext, "mode" | "state" | "flags" | "knownFactValues">,
): string | undefined {
  if (text.length > MAX_TOTAL) return "TOO_LONG";
  if (MARKUP.test(text)) return "MARKUP";
  if (
    SECRETS.test(text) &&
    !(MAY_NAME_PIN.has(context.state) && !/\b(enter|type|send|share|tell)\b/i.test(text))
  ) {
    return "SECRET_WORDS";
  }
  if (LEAKS.test(text)) return "LEAK";
  if (context.mode === "MODEL_FULL" && PHANTOM_BLOCK.test(text)) return "PHANTOM_BLOCK";
  if (OUTCOME_CLAIM.test(text) || (text.includes("✅") && !MAY_CELEBRATE.has(context.state))) {
    return "OUTCOME_CLAIM";
  }
  if (UNBUILT.test(text)) return "UNBUILT_FEATURE";
  if (!context.flags.rates && /\b(rates?|quotes?)\b/i.test(text)) return "UNAVAILABLE_RATES";
  if (!context.flags.balance && /\bbalances?\b/i.test(text)) return "UNAVAILABLE_BALANCE";
  if (!context.flags.send && /\b(send|sending|payments?)\b/i.test(text)) {
    return "UNAVAILABLE_SEND";
  }
  if ((text.match(/\p{Extended_Pictographic}/gu) ?? []).length > MAX_EMOJI) return "EMOJI";

  const trusted = new Set(context.knownFactValues.flatMap(numbersIn));
  if (numbersIn(text).some((value) => !trusted.has(value))) return "UNTRUSTED_NUMBER";

  return undefined;
}

/** A reply that arrived as plain streamed text rather than as the structured object, checked exactly like one. */
export function validateStreamedText(text: string, context: ValidateContext): Validation {
  return validateReply(
    { acknowledgement: null, body: text, question: null, closing: null, suggestedActionIds: [] },
    context,
  );
}
