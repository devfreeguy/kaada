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
    /**
     * Room to answer in, not room to think in — and the two share this budget.
     *
     * A reasoning model spends completion tokens reasoning BEFORE it writes the JSON, so a ceiling that fits the answer
     * does not fit the answer plus the thinking that reaches it. At 512 the easy sentences landed in 194-273 tokens and
     * the harder ones spent all 512 reasoning and returned an EMPTY completion: no JSON at all, read as unusable
     * output, answered "Sorry, I didn't understand that."
     *
     * "Send $1 worth of Argentine Pesos to @someone" failed that way every time while "Send $1 to @someone" succeeded,
     * which looks exactly like a model that cannot read English and is nothing of the kind. Worse, with an operation
     * already open the failure is invisible: the coordinator restates what is in progress, so three failed sends in a
     * row came back as the same rate quoted three times, as though the agent were ignoring the person.
     *
     * Generous on purpose. Unused room costs nothing — billing and the daily budget count tokens actually generated,
     * and the successful calls above show what that really is.
     */
    this.maxCompletionTokens = options.maxCompletionTokens ?? 2_048;
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
      this.record(started, {
        success: false,
        errorKind: kind,
        // Names the exhausted quota when Groq named one, so a spent daily budget is not read as a throughput problem.
        ...(error instanceof GroqTransportError &&
          error.scope !== undefined && { limit: error.scope }),
      });
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
      limit?: string;
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
      // Only when Groq named a quota: a turn that never hit one should not carry an empty field saying so.
      ...(details.limit !== undefined && { limit: details.limit }),
      promptTokens: details.result?.usage.promptTokens,
      completionTokens: details.result?.usage.completionTokens,
      totalTokens: details.result?.usage.totalTokens,
    });
  }
}
