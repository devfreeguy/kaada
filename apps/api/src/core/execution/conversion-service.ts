import { KaadaError, isSessionOpen } from "@kaada/domain";
import type { AuthorizationSession } from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import type { PaymentAuthorizationService } from "../authorization/payment-authorization-service.js";
import type { ExecutionPreparationService } from "./preparation-service.js";
import type { ExecutionRunner } from "./runner.js";
import type { RunTracker } from "./run-tracker.js";
import type { PreparationTracker } from "./tracker.js";

export interface ConversionServiceDeps {
  sessions: { findById(id: string): Promise<AuthorizationSession | null> };
  payments: Pick<PaymentAuthorizationService, "authorizeConversion">;
  preparation: Pick<ExecutionPreparationService, "prepare">;
  runner: Pick<ExecutionRunner, "run">;
  preparations: PreparationTracker;
  runs: RunTracker;
  now?: () => Date;
  log?: AgentLog;
}

export type ConversionStart = { status: "STARTED" } | { status: "NOT_AVAILABLE" };

/**
 * Carries out a conversion between a person's own currencies after ONE tap, with no PIN and no passkey prompt.
 *
 * It does exactly what the secure payment page does for a PIN payment (authorize, price the final quote, run), but on the
 * server and without the PIN. The first run of a pair still needs the wallet's one-time setup, signed with the person's
 * own passkey, and the chat announces that step as it does for any payment; every later conversion of the same pair runs
 * from start to finish with nothing asked.
 *
 * Who can reach it: only the chat layer, after the person pressed a server-bound button that belongs to them. Whether the
 * payment really is a conversion is decided by the authorization service from storage, not by anything passed in here.
 */
export class ConversionService {
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(private readonly deps: ConversionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  async confirm(input: { userId: string; sessionId: string }): Promise<ConversionStart> {
    const session = await this.deps.sessions.findById(input.sessionId);
    // Someone else's session, or one that is no longer open, is the same answer as one that never existed.
    if (!session || session.userId !== input.userId || !isSessionOpen(session, this.now())) {
      return { status: "NOT_AVAILABLE" };
    }

    let authorizationId: string;
    try {
      authorizationId = (await this.deps.payments.authorizeConversion(session)).id;
    } catch (error) {
      if (error instanceof KaadaError && error.code === "AUTHORIZATION_SESSION_INVALID") {
        return { status: "NOT_AVAILABLE" };
      }
      throw error;
    }

    // In the background, like the payment page's own calls: the person is told how it goes as it moves.
    this.deps.preparations.start(authorizationId, async () => {
      const outcome = await this.deps.preparation.prepare(authorizationId);
      if (outcome.status === "EXECUTION_READY") {
        this.deps.runs.start(outcome.executionId, () => this.deps.runner.run(outcome.executionId));
      } else {
        this.log("info", "conversion.not_started", { status: outcome.status });
      }
      return outcome;
    });
    return { status: "STARTED" };
  }
}
