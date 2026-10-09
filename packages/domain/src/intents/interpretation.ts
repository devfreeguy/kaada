import type { AgentIntent } from "./agent-intent.js";

/**
 * Control signals about the conversation itself, kept apart from financial intents so the
 * financial intent types stay about money.
 * - CANCEL_ACTIVE_INTENT: "cancel that" - drop the operation in progress.
 * - START_OVER:           "let's start over" - drop it and begin fresh.
 */
export const AGENT_COMMANDS = ["CANCEL_ACTIVE_INTENT", "START_OVER"] as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[number];

/** What the language stage made of one message: a (possibly partial) intent, or a command. */
export type Interpretation =
  { kind: "INTENT"; intent: AgentIntent } | { kind: "COMMAND"; command: AgentCommand };
