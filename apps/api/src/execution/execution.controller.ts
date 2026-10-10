import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Repositories } from "@kaada/database";
import { isKaadaError } from "@kaada/domain";

import { AUTHORIZATION_SESSION_SERVICE } from "../authorization/authorization.tokens.js";
import type { AuthorizationSessionService } from "../core/authorization/session-service.js";
import type {
  ExecutionPreparationService,
  PreparationOutcome,
} from "../core/execution/preparation-service.js";
import { preparationMessage } from "../core/execution/preparation-service.js";
import { PreparationTracker, outcomeFromRecord } from "../core/execution/tracker.js";
import {
  EXECUTION_PREPARATION_SERVICE,
  EXECUTION_REPOSITORIES,
  PREPARATION_TRACKER,
} from "./execution.tokens.js";

function bearer(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match?.[1]) throw new UnauthorizedException("an authorization token is required");
  return match[1];
}

/** What a browser may learn: a state and a safe sentence. No ids, amounts, calldata or secrets. */
function view(outcome: PreparationOutcome | undefined, running: boolean) {
  if (!outcome) {
    return {
      state: running ? "PREPARING" : "NOT_STARTED",
      message: "Confirming the final price...",
    };
  }
  return {
    state: outcome.status,
    message: preparationMessage(outcome),
    ...(outcome.status === "REAUTHORIZATION_REQUIRED" && { reason: outcome.reason }),
  };
}

/**
 * Starts and follows the preparation of an authorized payment. The only identity is the secure link
 * token of the session the PIN just completed: the authorization, wallet and taker come from storage.
 * Nothing here signs, sends or submits; the strongest word it ever says is "authorized and priced".
 */
@Controller({ path: "execution", version: "1" })
export class ExecutionController {
  constructor(
    @Inject(AUTHORIZATION_SESSION_SERVICE)
    private readonly sessions: AuthorizationSessionService | null,
    @Inject(EXECUTION_PREPARATION_SERVICE)
    private readonly preparation: ExecutionPreparationService | null,
    @Inject(PREPARATION_TRACKER) private readonly tracker: PreparationTracker,
    @Inject(EXECUTION_REPOSITORIES) private readonly repositories: Repositories,
  ) {}

  private async authorizationFor(token: string) {
    if (!this.sessions) throw new ServiceUnavailableException("execution is not enabled");
    try {
      const session = await this.sessions.resolveAuthorized(token);
      const authorization = await this.repositories.paymentAuthorizations.findBySession(session.id);
      if (!authorization) throw new UnauthorizedException("no authorization for this link");
      return authorization;
    } catch (error) {
      if (isKaadaError(error, "AUTHORIZATION_SESSION_INVALID")) {
        throw new UnauthorizedException("this link is not valid or has expired");
      }
      throw error;
    }
  }

  /** Begins confirming the final price. Safe to repeat: a duplicate never costs another provider slot. */
  @Post("prepare")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  async prepare(@Headers("authorization") authorization?: string) {
    const preparation = this.preparation;
    if (!preparation) throw new ServiceUnavailableException("final pricing is not enabled");
    const payment = await this.authorizationFor(bearer(authorization));
    this.tracker.start(payment.id, () => preparation.prepare(payment.id));
    return view(this.tracker.outcome(payment.id), true);
  }

  @Get("outcome")
  @Header("Cache-Control", "no-store")
  async outcome(@Headers("authorization") authorization?: string) {
    const payment = await this.authorizationFor(bearer(authorization));
    const running = this.tracker.isRunning(payment.id);
    const known =
      this.tracker.outcome(payment.id) ??
      outcomeFromRecord(await this.repositories.executionPlans.findByAuthorization(payment.id));
    return view(running ? undefined : known, running);
  }
}
