import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Repositories } from "@kaada/database";
import type { AppConfig } from "@kaada/config";
import { createId } from "@kaada/domain";
import { agentMessageRequestSchema } from "@kaada/schemas";

import { APP_CONFIG } from "../config/config.module.js";
import type { AgentService } from "../core/agent/agent-service.js";
import { ConversationAccessError } from "../core/agent/errors.js";
import type { AgentResponse } from "../core/responses/agent-response.js";
import { AGENT_REPOSITORIES, AGENT_SERVICE } from "./agent.tokens.js";

interface AgentMessageReply {
  userId: string;
  conversationId: string;
  messageId: string;
  intentId?: string;
  duplicate: boolean;
  response: AgentResponse;
}

/**
 * INTERNAL development endpoint for exercising the agent before any channel exists. It is not part
 * of the public API: it does not exist in production, and the body carries only what a person
 * typed. The interpreted intent is never accepted from the caller.
 */
@Controller({ path: "agent", version: "1" })
export class AgentController {
  constructor(
    @Inject(AGENT_SERVICE) private readonly agent: AgentService | null,
    @Inject(AGENT_REPOSITORIES) private readonly repositories: Repositories,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post("messages")
  @HttpCode(200)
  async sendMessage(@Body() body: unknown): Promise<AgentMessageReply> {
    if (this.config.nodeEnv === "production") throw new NotFoundException();
    if (!this.agent) {
      throw new ServiceUnavailableException(
        "No intent interpreter is configured. For development set AGENT_INTERPRETER=mock.",
      );
    }

    const parsed = agentMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ message: "invalid request", issues: parsed.error.issues });
    }
    const { content, conversationId } = parsed.data;

    // Development convenience: omit userId to get a throwaway user back.
    let userId = parsed.data.userId;
    if (userId === undefined) {
      userId = createId();
      await this.repositories.users.create({ id: userId, displayName: "Dev user" });
    } else if (!(await this.repositories.users.findById(userId))) {
      throw new NotFoundException("user not found");
    }

    let externalConversationId = `web-${createId()}`;
    if (conversationId !== undefined) {
      const existing = await this.repositories.conversations.findById(conversationId);
      if (!existing || existing.userId !== userId || !existing.externalConversationId) {
        throw new NotFoundException("conversation not found");
      }
      externalConversationId = existing.externalConversationId;
    }

    try {
      const turn = await this.agent.handleMessage({
        userId,
        channel: "WEB",
        externalConversationId,
        content,
      });
      return {
        userId,
        conversationId: turn.conversationId,
        messageId: turn.messageId,
        duplicate: turn.duplicate,
        response: turn.response,
        ...(turn.intentId && { intentId: turn.intentId }),
      };
    } catch (error) {
      if (error instanceof ConversationAccessError) throw new ForbiddenException();
      throw error;
    }
  }
}
