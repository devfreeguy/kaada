/*
 * One rule for every async action a person starts on a page (confirm a payment, save a PIN, change a credential):
 *
 *   - ONE operation runs at a time. A second start while one is running is refused, synchronously, before any request.
 *   - Only the operation that is still CURRENT may write to the screen. If the page moved on (a new attempt, a different
 *     flow, a reload, unmount) its late answer is dropped instead of overwriting what the person now sees.
 *   - A success is FINAL for the attempt: nothing that finishes afterwards can replace it with a failure.
 *
 * This is deliberately framework-free so the rules can be tested without a browser; `useOperation` binds it to React.
 */

export interface Operation {
  /** Writes to the screen only if this operation is still the current one. Returns whether it wrote. */
  commit(write: () => void): boolean;
  /** A terminal success: writes, then refuses every later start and every later write until `reset()`. */
  succeed(write: () => void): boolean;
  /** Ends the operation without writing (the caller already showed what it needed to). */
  finish(): void;
  isCurrent(): boolean;
}

export interface OperationGate {
  /** Starts an operation, or returns null when one is already running or the attempt already succeeded. */
  begin(): Operation | null;
  /** Entering a new context (another flow, a reload, a retry from scratch): forget the old attempt entirely. */
  reset(): void;
  /** The page is gone: nothing may write any more. Reversible with `revive` (React Strict Mode mounts twice). */
  dispose(): void;
  revive(): void;
  readonly running: boolean;
  readonly succeeded: boolean;
}

export function createOperationGate(): OperationGate {
  let generation = 0;
  let running = false;
  let succeeded = false;
  let disposed = false;

  return {
    begin() {
      if (disposed || running || succeeded) return null;
      generation += 1;
      running = true;
      const mine = generation;
      const current = () => !disposed && generation === mine;
      return {
        isCurrent: current,
        commit(write) {
          // A success is final: nothing, not even this attempt's own late failure, writes after it.
          if (!current() || succeeded) return false;
          write();
          return true;
        },
        succeed(write) {
          if (!current() || succeeded) return false;
          write();
          succeeded = true;
          running = false;
          return true;
        },
        finish() {
          if (generation === mine) running = false;
        },
      };
    },
    reset() {
      generation += 1;
      running = false;
      succeeded = false;
    },
    dispose() {
      disposed = true;
      generation += 1;
      running = false;
    },
    revive() {
      disposed = false;
    },
    get running() {
      return running;
    },
    get succeeded() {
      return succeeded;
    },
  };
}
