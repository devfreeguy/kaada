import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { AppConfig } from "@kaada/config";

import { APP_CONFIG } from "../config/config.module.js";
import type { ExecutionRunner } from "../core/execution/runner.js";
import { EXECUTION_RUNNER } from "./execution.tokens.js";

/**
 * Continues unfinished payments: anything sent but not yet settled, a root action that has since been
 * confirmed, a provider that was unreachable. It re-reads persisted state every time, so running it
 * twice, concurrently or after a crash is safe. No queue: a timer (and the explicit `reconcileNow`).
 */
@Injectable()
export class ExecutionReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionReconciler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(EXECUTION_RUNNER) private readonly runner: ExecutionRunner | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const every = this.config.execution.reconcileIntervalMs;
    if (!this.runner || every <= 0) return;
    // First pass shortly after start (picks up what a restart interrupted), then on the interval.
    this.timer = setInterval(() => void this.reconcileNow(), every);
    this.timer.unref();
    setTimeout(() => void this.reconcileNow(), 1_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcileNow(): Promise<{ examined: number } | undefined> {
    if (!this.runner || this.running) return undefined;
    this.running = true;
    try {
      const result = await this.runner.reconcile();
      if (result.examined > 0) {
        this.logger.log(`reconciled ${String(result.examined)} execution(s)`);
      }
      return { examined: result.examined };
    } catch {
      this.logger.warn("reconciliation failed; it will be tried again");
      return undefined;
    } finally {
      this.running = false;
    }
  }
}
