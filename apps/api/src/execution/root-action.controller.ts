import {
  Body,
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
import { isKaadaError } from "@kaada/domain";

import type { RootActionService } from "../core/execution/root-action-service.js";
import { ROOT_ACTION_SERVICE } from "./execution.tokens.js";

function bearer(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match?.[1]) throw new UnauthorizedException("a root-action token is required");
  return match[1];
}

/**
 * The secure page for wallet setup (account deployment and permission installation). The only identity
 * is the opaque link token. The server fixes the operation and its challenge; the browser can send back
 * nothing but the passkey's assertion over that challenge. The PIN is never involved here.
 */
@Controller({ path: "root-action", version: "1" })
export class RootActionController {
  constructor(@Inject(ROOT_ACTION_SERVICE) private readonly service: RootActionService | null) {}

  private active(): RootActionService {
    if (!this.service) throw new ServiceUnavailableException("wallet setup is not enabled");
    return this.service;
  }

  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        isKaadaError(error, "AUTHORIZATION_SESSION_INVALID") ||
        isKaadaError(error, "CREDENTIAL_REJECTED")
      ) {
        throw new UnauthorizedException("this link is not valid, has expired, or was already used");
      }
      throw error;
    }
  }

  @Get("view")
  @Header("Cache-Control", "no-store")
  view(@Headers("authorization") authorization?: string) {
    return this.guarded(() => this.active().view(bearer(authorization)));
  }

  @Get("options")
  @Header("Cache-Control", "no-store")
  options(@Headers("authorization") authorization?: string) {
    return this.guarded(() => this.active().options(bearer(authorization)));
  }

  /** Takes the passkey assertion and nothing else: no operation, address, amount or calldata. */
  @Post("complete")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  async complete(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { assertion?: unknown },
  ) {
    await this.guarded(() => this.active().complete(bearer(authorization), body.assertion));
    // The result is "accepted"; whether it reached the chain is reported by the payment status.
    return { state: "PROCESSING_PAYMENT" };
  }
}
