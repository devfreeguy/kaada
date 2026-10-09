import type { Interpretation } from "@kaada/domain";

import type { IntentInterpreter, InterpretationInput } from "./interpreter.js";

type Responder = (
  input: InterpretationInput,
  callIndex: number,
) => Interpretation | Promise<Interpretation>;

/**
 * A scripted interpreter for tests and development. It does no language understanding: the caller
 * decides exactly which structured result each message produces.
 */
export class MockIntentInterpreter implements IntentInterpreter {
  /** Every input received, in order. */
  readonly calls: InterpretationInput[] = [];

  constructor(private readonly respond: Responder) {}

  /** Returns the given interpretations one per call, and fails loudly if the script runs out. */
  static sequence(...interpretations: Interpretation[]): MockIntentInterpreter {
    return new MockIntentInterpreter((_input, index) => {
      const next = interpretations[index];
      if (!next) throw new Error(`MockIntentInterpreter script exhausted at call ${index + 1}`);
      return next;
    });
  }

  /** Maps an exact message (after trimming and lower-casing) to its interpretation. */
  static byMessage(
    script: Record<string, Interpretation>,
    fallback: Interpretation = { kind: "INTENT", intent: { type: "UNKNOWN" } },
  ): MockIntentInterpreter {
    const table = new Map(Object.entries(script).map(([key, value]) => [normalize(key), value]));
    return new MockIntentInterpreter((input) => table.get(normalize(input.message)) ?? fallback);
  }

  interpret(input: InterpretationInput): Promise<Interpretation> {
    const index = this.calls.length;
    this.calls.push(input);
    try {
      return Promise.resolve(this.respond(input, index));
    } catch (error) {
      // A real interpreter fails by rejecting, never by throwing synchronously.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function normalize(message: string): string {
  return message.trim().replace(/\s+/g, " ").toLowerCase();
}
