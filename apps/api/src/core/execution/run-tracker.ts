import type { RunOutcome } from "./runner.js";

/**
 * Runs a payment execution in the background and remembers how the last call ended. One call per
 * execution at a time in this process; across processes the database lock (the conditional
 * READY -> SIGNING transition) is what keeps a second runner from paying twice.
 */
export class RunTracker {
  private readonly running = new Map<string, Promise<void>>();
  private readonly latest = new Map<string, { outcome: RunOutcome; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  start(executionId: string, run: () => Promise<RunOutcome>): "STARTED" | "RUNNING" {
    if (this.running.has(executionId)) return "RUNNING";
    const job = run()
      .then((outcome) => {
        this.latest.set(executionId, { outcome, at: this.now() });
      })
      .catch(() => {
        // An unexpected failure is never reported as success or as a clean failure: it is pending.
        this.latest.set(executionId, { outcome: { status: "PAYMENT_PENDING" }, at: this.now() });
      })
      .finally(() => {
        this.running.delete(executionId);
        this.prune();
      });
    this.running.set(executionId, job);
    return "STARTED";
  }

  isRunning(executionId: string): boolean {
    return this.running.has(executionId);
  }

  outcome(executionId: string): RunOutcome | undefined {
    return this.latest.get(executionId)?.outcome;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  private prune(): void {
    const cutoff = this.now() - 30 * 60 * 1000;
    for (const [id, entry] of this.latest) if (entry.at < cutoff) this.latest.delete(id);
  }
}
