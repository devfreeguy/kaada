import { z } from "zod";

import { noopLog } from "../../core/agent/ports.js";
import type { AgentLog } from "../../core/agent/ports.js";
import type { SuggestionId } from "../../core/conversation/capabilities.js";
import type { ConversationWriter } from "../../core/conversation/presenter.js";
import type { ConversationPrompt } from "../../core/conversation/prompt.js";
import { replySchema } from "../../core/conversation/reply.js";
import { GroqTransportError } from "./groq-transport.js";
import type { GroqTransport } from "./groq-transport.js";
import { stripUnsupported } from "./intent-wire.js";

export interface GroqConversationWriterOptions {
  model: string;
  timeoutMs: number;
  /** A little warmth so greetings do not read the same every time. Presentation only. */
  temperature: number;
  /** Cap on generated tokens, reasoning included. */
  maxCompletionTokens?: number;
  log?: AgentLog;
  now?: () => number;
}

const SCHEMA_NAME = "kaada_reply";

/** The JSON Schema sent to Groq, generated from the same Zod schema the reply is validated with, so the two cannot drift. */
export function replyJsonSchema(): Record<string, unknown> {
  const generated: unknown = JSON.parse(JSON.stringify(z.toJSONSchema(replySchema)));
  const stripped = stripUnsupported(generated);
  if (stripped === null || typeof stripped !== "object" || Array.isArray(stripped)) {
    throw new Error("unexpected JSON schema shape");
  }
  return Object.fromEntries(Object.entries(stripped));
}

/**
 * The conversation presenter's model: ONE Groq call with strict structured output that returns candidate wording. It is a
 * different responsibility from the intent interpreter (separate prompt, separate schema, separate module): it never reads
 * the person's request into data and never touches state. What it returns is untrusted and is validated by the core before
 * any of it is used; a failure here only means the fixed wording is used instead.
 */
export class GroqConversationWriter implements ConversationWriter {
  private readonly schema = replyJsonSchema();
  private readonly log: AgentLog;
  private readonly now: () => number;

  constructor(
    private readonly transport: GroqTransport,
    private readonly options: GroqConversationWriterOptions,
  ) {
    this.log = options.log ?? noopLog;
    this.now = options.now ?? Date.now;
  }

  async write(prompt: ConversationPrompt, _allowed: readonly SuggestionId[]): Promise<unknown> {
    const started = this.now();
    try {
      const result = await this.transport.chat({
        model: this.options.model,
        system: prompt.system,
        user: prompt.user,
        schemaName: SCHEMA_NAME,
        schema: this.schema,
        maxCompletionTokens: this.options.maxCompletionTokens ?? 600,
        timeoutMs: this.options.timeoutMs,
        temperature: this.options.temperature,
      });
      const content = result.content?.trim();
      if (!content) throw new Error("EmptyPresentation");
      const parsed: unknown = JSON.parse(content);
      // Safe metadata only: never the prompt, the person's message, or the model's words.
      this.log("info", "llm.present", {
        provider: "groq",
        model: result.model,
        latencyMs: this.now() - started,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      });
      return parsed;
    } catch (error) {
      this.log("warn", "llm.present.failed", {
        provider: "groq",
        latencyMs: this.now() - started,
        errorKind: error instanceof GroqTransportError ? error.kind : (error as Error).name,
      });
      throw error;
    }
  }
}
