import { Logger } from "@nestjs/common";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import type { DeploymentCheckResult } from "@kaada/blockchain";

export interface DeploymentGuardOptions {
  /** The read-only comparison of the configured contracts with the chain. Null: nothing to check (recovery and device keys are off). */
  check: (() => Promise<DeploymentCheckResult>) | null;
  /** Quick attempts made before the server starts listening; an outage that outlasts them is handled in the background. */
  bootAttempts?: number;
  bootDelayMs?: number;
  /** Pause between background retries, doubling up to `maxRetryDelayMs`. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called when a mismatch is found after the server is already up. The process keeps running; this switches recovery off. */
  onLateMismatch?: (message: string) => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Proves at startup that the contracts in deployments.ts are the ones on chain, so a wrong address fails loudly now and not in the
 * middle of someone's recovery. A DEFINITIVE mismatch (the chain answered, and differently) refuses to start and names both values.
 * An RPC outage proves nothing, so it never stops the server and never causes a restart loop: it logs
 * `recovery.chain_check_unavailable`, serves, and keeps retrying in the background. If that retry then finds a real mismatch it logs
 * `recovery.chain_mismatch` at error level and calls `onLateMismatch` (which switches recovery and device keys off); it never stops the
 * process.
 */
export class DeploymentGuard implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger("Recovery");
  private stopped = false;

  constructor(private readonly options: DeploymentGuardOptions) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.check) return;
    const attempts = this.options.bootAttempts ?? 3;
    const sleep = this.options.sleep ?? wait;
    let last: DeploymentCheckResult = { status: "UNAVAILABLE", reason: "not tried" };
    for (let attempt = 1; attempt <= attempts && !this.stopped; attempt += 1) {
      last = await this.attempt(attempt);
      if (last.status !== "UNAVAILABLE") break;
      if (attempt < attempts) await sleep((this.options.bootDelayMs ?? 1_000) * attempt);
    }
    if (last.status === "MISMATCH")
      throw new Error(`${this.mismatchText(last)}. Refusing to start`);
    if (last.status === "UNAVAILABLE") void this.retryInBackground();
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  private async attempt(attempt: number): Promise<DeploymentCheckResult> {
    let result: DeploymentCheckResult;
    try {
      result = await (this.options.check as () => Promise<DeploymentCheckResult>)();
    } catch (error) {
      result = {
        status: "UNAVAILABLE",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.status === "OK") {
      this.log.log("recovery.chain_check_ok: the deployed contracts match deployments.ts");
    } else if (result.status === "UNAVAILABLE") {
      this.log.warn(
        `recovery.chain_check_unavailable: could not read the chain (attempt ${String(attempt)}); the server keeps running and retries: ${result.reason}`,
      );
    }
    return result;
  }

  private async retryInBackground(): Promise<void> {
    const sleep = this.options.sleep ?? wait;
    const max = this.options.maxRetryDelayMs ?? 300_000;
    let delay = this.options.retryDelayMs ?? 30_000;
    for (let attempt = 1; !this.stopped; attempt += 1) {
      await sleep(delay);
      if (this.stopped) return;
      const result = await this.attempt(attempt);
      if (result.status === "OK") return;
      if (result.status === "MISMATCH") {
        const message = this.mismatchText(result);
        this.log.error(
          `recovery.chain_mismatch: ${message}. Recovery and device-key wallets are switched off until this is fixed and the server restarted`,
        );
        this.options.onLateMismatch?.(message);
        return;
      }
      delay = Math.min(delay * 2, max);
    }
  }

  private mismatchText(result: Extract<DeploymentCheckResult, { status: "MISMATCH" }>): string {
    const text = `the deployed recovery contracts do not match deployments.ts (${result.problems.join("; ")})`;
    return text;
  }
}
