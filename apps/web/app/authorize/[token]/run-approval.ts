import type { OperationGate } from "../../lib/operation-gate";
import type { AuthorizationEvent, Method } from "./authorization-machine";
import { confirmPayment } from "./confirm-payment";
import type { ConfirmDeps } from "./confirm-payment";

/**
 * One attempt to approve a payment, start to finish, written so it cannot end in a stale state:
 *
 *  - it starts only if no attempt is running and the payment was not already approved (the gate, checked synchronously, so a
 *    double tap never sends a second request);
 *  - every screen change it makes goes through the gate, so if the page moved on while it waited, its answer is dropped;
 *  - an approval is final: once it is shown, no later answer can replace it with a failure.
 */
export async function runApproval(
  context: {
    gate: OperationGate;
    dispatch(event: AuthorizationEvent): void;
    deps: ConfirmDeps;
  },
  input: { token: string; method: Method; pin: string },
): Promise<void> {
  const { gate, dispatch, deps } = context;
  const operation = gate.begin();
  if (!operation) return;
  dispatch({ type: "submit" });
  try {
    const outcome = await confirmPayment(deps, input);
    switch (outcome.type) {
      case "approved":
        operation.succeed(() => dispatch({ type: "succeeded" }));
        return;
      case "failed":
        operation.commit(() =>
          dispatch({
            type: "failed",
            notice: outcome.notice,
            ...(outcome.lock !== undefined && { lock: outcome.lock }),
          }),
        );
        return;
      case "invalid":
        operation.commit(() => dispatch({ type: "moved", state: { name: "invalid" } }));
        return;
      case "blocked":
        operation.commit(() =>
          dispatch({ type: "moved", state: { name: "blocked", reason: outcome.reason } }),
        );
        return;
    }
  } finally {
    operation.finish();
  }
}
