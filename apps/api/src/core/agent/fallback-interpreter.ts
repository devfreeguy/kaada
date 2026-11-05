import type { Interpretation } from "@kaada/domain";

import { InterpreterUnavailableError } from "./interpreter.js";
import type { IntentInterpreter, InterpretationInput } from "./interpreter.js";
import type { AgentLog } from "./ports.js";
import { noopLog } from "./ports.js";

/** One provider in the chain, with the name it is called by in logs. Never a key or an endpoint. */
export interface InterpreterLink {
  /** A short, stable name: "anthropic", "cerebras", "groq", "gemini". It appears in every log line. */
  name: string;
  interpreter: IntentInterpreter;
}

/**
 * Several interpreters, tried in order, so one provider's outage or spent quota does not take the agent down.
 *
 * WHAT IS AND IS NOT FALLEN BACK FROM
 *
 * Only `InterpreterUnavailableError` moves to the next provider: the provider did not answer at all (rate limited, timed
 * out, unreachable, refused the key). There is nothing to lose by asking someone else.
 *
 * `InterpreterOutputError` deliberately does NOT. There the model DID answer and its answer was unusable, which the agent
 * already handles properly by treating the message as not understood and re-asking. Trying the next provider would add a
 * second call's latency to every malformed generation, and would hide prompt faults behind whichever model happens to
 * tolerate them — exactly the faults the drilling exists to find.
 *
 * WHY THE SWITCH IS LOUD
 *
 * A fallback means the agent is being read by a model other than the one its prompt was tuned and drilled against, so it
 * may understand the same sentence differently. That is worth having when the alternative is no answer at all, but it is
 * never worth having silently: every switch is logged with the provider that failed, the provider that served, and why.
 * A configuration fault (a bad key, a malformed request) is logged at error level, because unlike a rate limit it will
 * not heal on its own and would otherwise be paid for, quietly, by the next provider in the list.
 */
export class FallbackIntentInterpreter implements IntentInterpreter {
  private readonly links: readonly InterpreterLink[];
  private readonly log: AgentLog;

  constructor(links: readonly InterpreterLink[], log: AgentLog = noopLog) {
    if (links.length === 0) throw new Error("a fallback interpreter needs at least one provider");
    this.links = links;
    this.log = log;
  }

  /** The provider order, for a startup line that states which model actually answers people. */
  get providers(): string[] {
    return this.links.map((link) => link.name);
  }

  async interpret(input: InterpretationInput): Promise<Interpretation> {
    const failures: { provider: string; kind: string }[] = [];

    for (const [index, link] of this.links.entries()) {
      const last = index === this.links.length - 1;
      try {
        const interpretation = await link.interpreter.interpret(input);
        if (index > 0) {
          this.log("warn", "agent.interpreter.fallback.served", {
            provider: link.name,
            position: index,
            after: failures.map((failure) => `${failure.provider}:${failure.kind}`).join(","),
          });
        }
        return interpretation;
      } catch (error) {
        // The model answered and the answer was unusable: a different provider cannot improve on that, and asking one
        // would mask the fault. This is the agent's "not understood" path, and it belongs to the caller.
        if (!(error instanceof InterpreterUnavailableError)) throw error;

        failures.push({ provider: link.name, kind: error.kind });
        // AUTH and BAD_REQUEST are ours to fix, not the provider's to recover from. Said loudly, or a mistyped key is
        // paid for by the next provider in the chain for as long as nobody reads the logs.
        const level = error.kind === "AUTH" || error.kind === "BAD_REQUEST" ? "error" : "warn";
        this.log(level, "agent.interpreter.fallback.failed", {
          provider: link.name,
          position: index,
          kind: error.kind,
          ...(last ? { exhausted: true } : { next: this.links[index + 1]?.name }),
        });

        if (last) {
          throw new InterpreterUnavailableError(error.kind, { cause: error });
        }
      }
    }

    // Unreachable: the loop either returns or throws on the last link, and the constructor refuses an empty chain.
    throw new InterpreterUnavailableError("UNAVAILABLE");
  }
}
