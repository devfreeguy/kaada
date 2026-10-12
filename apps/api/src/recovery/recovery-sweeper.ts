import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { AppConfig } from "@kaada/config";

import { APP_CONFIG } from "../config/config.module.js";
import { RECOVERY_RUNTIME } from "./recovery.tokens.js";
import type { RecoveryRuntime } from "./recovery.runtime.js";

/**
 * Finalizes matured recoveries, reconciles anything the chain moved, finishes interrupted cleanups and expires stale
 * attempts. It re-reads persisted state every time, so a restart, two instances or a repeated pass are all safe: one
 * conditional update decides who drives a recovery.
 */
@Injectable()
export class RecoverySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecoverySweeper.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(RECOVERY_RUNTIME) private readonly runtime: RecoveryRuntime | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const every = this.config.recovery.sweepIntervalMs;
    if (!this.runtime || every <= 0) return;
    this.timer = setInterval(() => void this.sweepNow(), every);
    this.timer.unref();
    setTimeout(() => void this.sweepNow(), 2_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweepNow(): Promise<void> {
    if (!this.runtime || this.running) return;
    this.running = true;
    try {
      const result = await this.runtime.finalizer.runDue();
      if (result.finalized.length > 0 || result.reconciled > 0 || result.cleaned > 0) {
        this.logger.log(
          `recovery sweep: ${String(result.finalized.length)} finalized, ${String(result.reconciled)} reconciled, ${String(result.cleaned)} cleaned`,
        );
      }
    } catch {
      this.logger.warn("recovery sweep failed; it will be tried again");
    } finally {
      this.running = false;
    }
  }
}
