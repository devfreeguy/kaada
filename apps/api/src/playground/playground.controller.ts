import { Body, Controller, HttpCode, Inject, NotFoundException, Post } from "@nestjs/common";

import type { PlaygroundService, PlaygroundTurn } from "../core/playground/playground-service.js";
import { newSession } from "../core/playground/playground-service.js";
import { PLAYGROUND_SERVICE } from "./playground.tokens.js";

/*
 * The development agent playground's HTTP edge.
 *
 * Every route answers 404 unless the playground is enabled, and the provider behind PLAYGROUND_SERVICE is null unless
 * AGENT_PLAYGROUND is on, which configuration refuses outright in production. So in production these paths do not merely
 * refuse: there is nothing behind them.
 *
 * A session id is minted by the server and is the whole key to a session's conversation and identity. One browser cannot read
 * another's conversation without its id, and an id it does not hold resolves to a different WEB identity.
 */
@Controller({ path: "dev/playground", version: "1" })
export class PlaygroundController {
  constructor(
    @Inject(PLAYGROUND_SERVICE) private readonly playground: PlaygroundService | null,
  ) {}

  private get service(): PlaygroundService {
    if (!this.playground) throw new NotFoundException();
    return this.playground;
  }

  /** A fresh sandbox session: its own WEB identity and its own chat. */
  @Post("session")
  @HttpCode(200)
  session(): { sessionId: string; conversationId: string; executionMode: "simulation" } {
    // Touch the service first, so a disabled playground answers 404 here too.
    void this.service;
    return { ...newSession(), executionMode: "simulation" };
  }

  /** A typed message, handled exactly as a Telegram text message is. */
  @Post("message")
  @HttpCode(200)
  message(@Body() body: unknown): Promise<PlaygroundTurn> {
    const { sessionId, conversationId, text } = parseMessage(body);
    return this.service.message({ sessionId, conversationId }, text);
  }

  /** A pressed button, carrying the opaque handle the presenter issued. Never converted into text. */
  @Post("action")
  @HttpCode(200)
  action(@Body() body: unknown): Promise<PlaygroundTurn> {
    const { sessionId, conversationId, handle } = parseAction(body);
    return this.service.action({ sessionId, conversationId }, handle);
  }
}

class BadRequest extends NotFoundException {}

function field(body: unknown, name: string, max: number): string {
  const value = (body as Record<string, unknown> | null)?.[name];
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new BadRequest(`${name} is required`);
  }
  return value;
}

function parseMessage(body: unknown): {
  sessionId: string;
  conversationId: string;
  text: string;
} {
  return {
    sessionId: field(body, "sessionId", 100),
    conversationId: field(body, "conversationId", 100),
    text: field(body, "text", 2000),
  };
}

function parseAction(body: unknown): {
  sessionId: string;
  conversationId: string;
  handle: string;
} {
  return {
    sessionId: field(body, "sessionId", 100),
    conversationId: field(body, "conversationId", 100),
    handle: field(body, "handle", 64),
  };
}
