import type { Interpretation } from "@kaada/domain";
import { interpretationSchema } from "@kaada/schemas";

import {
  InterpreterOutputError,
  InterpreterUnavailableError,
} from "../../core/agent/interpreter.js";
import type { IntentInterpreter, InterpretationInput } from "../../core/agent/interpreter.js";
import { noopLog } from "../../core/agent/ports.js";
import type { AgentLog } from "../../core/agent/ports.js";
import { GroqTransportError } from "./groq-transport.js";
import type { GroqChatResult, GroqTransport } from "./groq-transport.js";
import {
  INTENT_SYSTEM_PROMPT,
  DEFAULT_CONTEXT_LIMITS,
  SCHEMA_NAME,
  buildUserPrompt,
} from "./intent-prompt.js";
import type { ContextLimits } from "./intent-prompt.js";
import { wireInterpretationSchema, wireJsonSchema, wireToCandidate } from "./intent-wire.js";

export interface GroqIntentInterpreterOptions {
  model: string;
  timeoutMs: number;
  /** Cap on generated tokens, reasoning included. Default 512. */
  maxCompletionTokens?: number;
  limits?: ContextLimits;
  log?: AgentLog;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

/**
 * Turns a message into an Interpretation with one Groq call.
 *
 * The model's reply is untrusted input. It must parse as JSON, match the strict wire schema, map
 * onto a legal intent (numbers read unambiguously, only fields that belong to the type), and then
 * pass interpretationSchema, the same schema every other source of intents must satisfy. Failing any
 * step raises InterpreterOutputError and nothing is guessed or retried. The interpreter has no
 * access to the database, recipients, assets, providers or any action.
 */
export class GroqIntentInterpreter implements IntentInterpreter {
  private readonly schema = wireJsonSchema();
  private readonly limits: ContextLimits;
  private readonly log: AgentLog;
  private readonly now: () => number;
  private readonly maxCompletionTokens: number;

  constructor(
    private readonly transport: GroqTransport,
    private readonly options: GroqIntentInterpreterOptions,
  ) {
    this.limits = options.limits ?? DEFAULT_CONTEXT_LIMITS;
    this.log = options.log ?? noopLog;
    this.now = options.now ?? Date.now;
    this.maxCompletionTokens = options.maxCompletionTokens ?? 512;
  }

  async interpret(input: InterpretationInput): Promise<Interpretation> {
    const started = this.now();
    let result: GroqChatResult;
    try {
      result = await this.transport.chat({
        model: this.options.model,
        system: INTENT_SYSTEM_PROMPT,
        user: buildUserPrompt(input, this.limits),
        schemaName: SCHEMA_NAME,
        schema: this.schema,
        maxCompletionTokens: this.maxCompletionTokens,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (error) {
      const kind = error instanceof GroqTransportError ? error.kind : "UNAVAILABLE";
      this.record(started, { success: false, errorKind: kind });
      // The model answered, but Groq refused the answer as off-schema: unusable output, not an outage.
      if (kind === "INVALID_OUTPUT") throw new InterpreterOutputError("PROVIDER_SCHEMA_REJECTED");
      throw new InterpreterUnavailableError(kind);
    }

    try {
      const interpretation = this.validate(result);
      this.record(started, {
        success: true,
        schemaValid: true,
        outcome:
          interpretation.kind === "COMMAND" ? interpretation.command : interpretation.intent.type,
        result,
      });
      return interpretation;
    } catch (error) {
      const reason = error instanceof InterpreterOutputError ? error.reason : "UNKNOWN";
      this.record(started, { success: false, schemaValid: false, errorKind: reason, result });
      throw error instanceof InterpreterOutputError ? error : new InterpreterOutputError(reason);
    }
  }

  private validate(result: GroqChatResult): Interpretation {
    const content = result.content?.trim();
    if (!content) throw new InterpreterOutputError("EMPTY");

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (error) {
      throw new InterpreterOutputError("NOT_JSON", { cause: error });
    }

    const wire = wireInterpretationSchema.safeParse(json);
    if (!wire.success) throw new InterpreterOutputError("WIRE_SCHEMA");

    const validated = interpretationSchema.safeParse(wireToCandidate(wire.data));
    if (!validated.success) throw new InterpreterOutputError("SCHEMA");
    return validated.data;
  }

  /** Safe metadata only: never the prompt, the message, the model's reply, or the API key. */
  private record(
    started: number,
    details: {
      success: boolean;
      schemaValid?: boolean;
      outcome?: string;
      errorKind?: string;
      result?: GroqChatResult;
    },
  ): void {
    this.log(details.success ? "info" : "warn", "llm.interpret", {
      provider: "groq",
      model: details.result?.model ?? this.options.model,
      latencyMs: this.now() - started,
      success: details.success,
      schemaValid: details.schemaValid,
      outcome: details.outcome,
      errorKind: details.errorKind,
      promptTokens: details.result?.usage.promptTokens,
      completionTokens: details.result?.usage.completionTokens,
      totalTokens: details.result?.usage.totalTokens,
    });
  }
}
