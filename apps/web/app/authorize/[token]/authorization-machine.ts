/*
 * What the payment approval screen is showing, as ONE state with explicit transitions.
 *
 * Failure notices and PIN lock times live INSIDE the `ready` state, not beside it. That is the point: a notice belongs to the
 * attempt that produced it, so it cannot outlive that attempt, appear again after a reload, or be carried into another payment.
 * And each event is only accepted from the state it makes sense in:
 *
 *   loaded / load-failed         only while loading
 *   submit                       only from ready
 *   failed / moved / succeeded   only while submitting
 *   done                         final: nothing but an explicit reset leaves it
 *
 * so a late answer from a previous request can never turn an approved payment back into a failure.
 */

export type Method = "PIN" | "PASSKEY" | "DEVICE_KEY";

interface MoneyView {
  display: string;
}
export interface Summary {
  amountMode: "EXACT_INPUT" | "EXACT_OUTPUT";
  recipient?: string;
  senderSpends: MoneyView;
  maximumSpend: MoneyView;
  recipientReceives: MoneyView;
  minimumReceive: MoneyView;
}
export interface View {
  summary: Summary;
  expiresAt: string;
  pin: { isSet: boolean; resetRequired: boolean; lockedUntil?: string };
}

/** A PIN lock: when it ends, and how long that is left in words (worked out when the lock is learned, never during render). */
export interface Lock {
  until: string;
  label: string;
}

/** How long a lock still has to run, in words, or null if it is over. */
export function lockLabel(until: string | null | undefined, now: number): string | null {
  if (!until) return null;
  const ms = new Date(until).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "about a minute" : `${minutes} minutes`;
}

export function toLock(until: string | null | undefined, now: number): Lock | null {
  const label = lockLabel(until, now);
  return until && label ? { until, label } : null;
}

export type AuthorizationState =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "load-error"; message: string }
  | { name: "blocked"; reason: "no-pin" | "reset" }
  | {
      name: "ready";
      view: View;
      method: Method;
      /** Why the last attempt did not go through. Cleared by the next attempt. */
      notice: string | null;
      /** Set while the PIN is locked. */
      lock: Lock | null;
    }
  | { name: "submitting"; view: View; method: Method }
  | { name: "done"; method: Method };

type Resolved = Exclude<AuthorizationState, { name: "loading" | "submitting" | "done" }>;

export type AuthorizationEvent =
  | { type: "reset" }
  | { type: "loaded"; state: Resolved }
  | { type: "load-failed"; state: Extract<AuthorizationState, { name: "invalid" | "load-error" }> }
  | { type: "submit" }
  | { type: "failed"; notice: string; lock?: Lock | null }
  | { type: "moved"; state: Extract<AuthorizationState, { name: "invalid" | "blocked" }> }
  | { type: "succeeded" }
  | { type: "lock-expired" };

export function authorizationReducer(
  state: AuthorizationState,
  event: AuthorizationEvent,
): AuthorizationState {
  switch (event.type) {
    case "reset":
      return { name: "loading" };
    case "loaded":
    case "load-failed":
      return state.name === "loading" ? event.state : state;
    case "submit":
      return state.name === "ready"
        ? { name: "submitting", view: state.view, method: state.method }
        : state;
    case "failed":
      return state.name === "submitting"
        ? {
            name: "ready",
            view: state.view,
            method: state.method,
            notice: event.notice,
            lock: event.lock ?? null,
          }
        : state;
    case "moved":
      return state.name === "submitting" ? event.state : state;
    case "succeeded":
      return state.name === "submitting" ? { name: "done", method: state.method } : state;
    case "lock-expired":
      return state.name === "ready" ? { ...state, lock: null } : state;
  }
}

/** The screen a freshly loaded payment starts on. */
export function initialScreen(view: View, method: Method, now: number): Resolved {
  if (method !== "PASSKEY" && !view.pin.isSet) return { name: "blocked", reason: "no-pin" };
  if (method !== "PASSKEY" && view.pin.resetRequired) return { name: "blocked", reason: "reset" };
  return {
    name: "ready",
    view,
    method,
    notice: null,
    lock: method === "PASSKEY" ? null : toLock(view.pin.lockedUntil, now),
  };
}
