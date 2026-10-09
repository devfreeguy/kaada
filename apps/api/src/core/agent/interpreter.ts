import type { AgentIntent, ConversationTurn, Interpretation } from "@kaada/domain";

export interface InterpretationInput {
  /** The message to interpret. */
  message: string;
  /** Earlier turns, oldest first, excluding `message`. */
  history: ConversationTurn[];
  /**
   * What the conversation currently has in progress, so "to Daniel" or "make that $40" can be read
   * as a follow-up. Context only: the interpreter never changes state.
   */
  activeIntent?: AgentIntent;
  now: Date;
}

/**
 * The application-facing boundary around the language model. Implementations turn text into a
 * structured Interpretation and nothing else: they do not touch the database, resolve recipients or
 * assets, or choose routes. Whatever they return is validated before it is used.
 */
export interface IntentInterpreter {
  interpret(input: InterpretationInput): Promise<Interpretation>;
}
