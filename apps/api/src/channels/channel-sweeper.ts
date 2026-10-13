import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Repositories } from "@kaada/database";

import type { OnboardingAnnouncer } from "../core/channels/onboarding-announcer.js";
import type { PaymentStatusDispatcher } from "../core/channels/payment-status.js";
import {
  CHANNEL_REPOSITORIES,
  ONBOARDING_ANNOUNCER,
  PAYMENT_STATUS_DISPATCHER,
} from "./channels.tokens.js";

const SWEEP_MS = 4_000;
const HOUSEKEEPING_MS = 60 * 60 * 1000;
const KEEP_EVENTS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keeps people told. A timer re-reads every unfinished payment from the database and announces what changed, so it works the
 * same after a restart or across instances (see PaymentStatusDispatcher), and it tidies old webhook claims and expired buttons.
 */
@Injectable()
export class ChannelSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelSweeper.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private onboardingRunning = false;

  constructor(
    @Inject(PAYMENT_STATUS_DISPATCHER) private readonly dispatcher: PaymentStatusDispatcher | null,
    @Inject(CHANNEL_REPOSITORIES) private readonly repositories: Repositories,
    @Inject(ONBOARDING_ANNOUNCER) private readonly onboarding: OnboardingAnnouncer | null,
  ) {}

  onModuleInit(): void {
    if (!this.dispatcher && !this.onboarding) return;
    this.timers.push(setInterval(() => void this.sweepNow(), SWEEP_MS).unref());
    this.timers.push(setInterval(() => void this.onboardingNow(), SWEEP_MS).unref());
    this.timers.push(setInterval(() => void this.tidy(), HOUSEKEEPING_MS).unref());
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  async sweepNow(): Promise<void> {
    if (!this.dispatcher || this.running) return;
    this.running = true;
    try {
      const { announced } = await this.dispatcher.sweep();
      if (announced > 0) this.logger.log(`announced ${String(announced)} payment update(s)`);
    } catch {
      this.logger.warn("payment status sweep failed; it will be tried again");
    } finally {
      this.running = false;
    }
  }

  /** Tells people their setup moved on (wallet ready, PIN set, all done). Safe to run from every instance at once. */
  async onboardingNow(): Promise<void> {
    if (!this.onboarding || this.onboardingRunning) return;
    this.onboardingRunning = true;
    try {
      const { announced, failed } = await this.onboarding.sweep();
      if (announced > 0) this.logger.log(`announced ${String(announced)} onboarding update(s)`);
      if (failed > 0) this.logger.warn(`${String(failed)} onboarding update(s) will be retried`);
    } catch {
      this.logger.warn("onboarding sweep failed; it will be tried again");
    } finally {
      this.onboardingRunning = false;
    }
  }

  private async tidy(): Promise<void> {
    try {
      const now = Date.now();
      await this.repositories.channelActions.deleteExpiredBefore(new Date(now), 500);
      await this.repositories.channelInboundEvents.deleteOlderThan(
        new Date(now - KEEP_EVENTS_MS),
        500,
      );
    } catch {
      this.logger.warn("channel housekeeping failed; it will be tried again");
    }
  }
}
