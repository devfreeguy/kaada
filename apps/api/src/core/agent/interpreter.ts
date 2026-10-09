import type { AgentIntent, ConversationTurn, Interpretation, MissingField } from "@kaada/domain";

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
  /** The detail Kaada last asked the user for, if the active intent is waiting on one. */
  pendingClarification?: MissingField;
  now: Date;
}

/**
 * The interpreter could not be reached or refused to answer (timeout, rate limit, outage). The
 * message was not understood or rejected: retrying later may work.
 */
export class InterpreterUnavailableError extends Error {
  override readonly name = "InterpreterUnavailableError";
  constructor(
    readonly kind: string,
    options?: { cause?: unknown },
  ) {
    super(`interpreter unavailable: ${kind}`, options);
  }
}

/**
 * The interpreter answered, but not with something usable (empty, not JSON, wrong shape, ambiguous
 * numbers). Retrying the same message would not be trustworthy, so callers fall back to "not
 * understood" rather than guess.
 */
export class InterpreterOutputError extends Error {
  override readonly name = "InterpreterOutputError";
  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`interpreter output unusable: ${reason}`, options);
  }
}

/**
 * The application-facing boundary around the language model. Implementations turn text into a
 * structured Interpretation and nothing else: they do not touch the database, resolve recipients or
 * assets, or choose routes. Whatever they return is validated before it is used.
 */
export interface IntentInterpreter {
  interpret(input: InterpretationInput): Promise<Interpretation>;
}
