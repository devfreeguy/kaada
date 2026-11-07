"use client";
import { useCallback, useEffect, useReducer, useState } from "react";
import { api, ApiError, describeError, json } from "../../lib/api";
import { logFailure } from "../../lib/client-log";
import { observeRequest } from "../../lib/observe-request";
import { useOperation } from "../../lib/use-operation";
import { proveRoot } from "../../lib/root-proof";
import { authorizationReducer, initialScreen } from "./authorization-machine";
import type { AuthorizationState, Method, View } from "./authorization-machine";
import { runApproval } from "./run-approval";

/**
 * How this payment is confirmed, decided by the server from the wallet's own root:
 *  - PASSKEY: one prompt, no PIN (the passkey signs the payment itself);
 *  - DEVICE_KEY: the PIN, then this device's key signs in the background (no second prompt);
 *  - PIN: the PIN alone (a wallet that cannot sign this payment itself).
 */
/** A transport failure must never silently select a different authorization method. */
async function methodFor(token: string): Promise<Method> {
  const body = await json<{ method: string; rootType?: string }>(
    await api("/authorization/root/method", token),
  );
  if (body.method === "PIN") return "PIN";
  if (body.method === "ROOT" && (body.rootType === "PASSKEY" || body.rootType === "DEVICE_KEY"))
    return body.rootType;
  throw new Error("Unsupported authorization method");
}

async function loadAuthorization(token: string) {
  const [view, method] = await Promise.all([
    api("/authorization", token).then(json<View>),
    methodFor(token),
  ]);
  // Every screen after this one speaks as the operation the server named: an unknown one is a load failure, not a "payment".
  if (view.operation !== "SEND" && view.operation !== "CONVERT")
    throw new Error("Unsupported operation");
  return initialScreen(view, method, Date.now());
}

const CONFIRM_DEPS = { api, proveRoot };

/**
 * The payment approval screen's controller. It holds no state of its own beyond the PIN being typed: what the screen shows is
 * the machine's state (authorization-machine.ts), and every attempt runs through the operation gate (run-approval.ts), so a
 * second tap, a late answer or a closed-and-reopened page can never leave a stale failure over an approved payment.
 *
 * The page is rendered per link (`key={token}`), so a different payment is always a fresh controller.
 */
export function useAuthorization({ token }: { token: string }) {
  const [state, dispatch] = useReducer(authorizationReducer, {
    name: "loading",
  } as AuthorizationState);
  const [pin, setPin] = useState("");
  const [revision, setRevision] = useState(0);
  const gate = useOperation();

  const reload = useCallback(() => {
    // A reload is a new context: forget the old attempt, its PIN and its notice.
    gate.reset();
    setPin("");
    dispatch({ type: "reset" });
    setRevision((value) => value + 1);
  }, [gate]);

  useEffect(
    () =>
      observeRequest(
        () => loadAuthorization(token),
        (screen) => dispatch({ type: "loaded", state: screen }),
        (error) => {
          logFailure("authorize.load_failed", error);
          dispatch({
            type: "load-failed",
            state:
              error instanceof ApiError && error.kind === "invalid"
                ? { name: "invalid" }
                : {
                    name: "load-error",
                    message: describeError(error, "Couldn't load this payment."),
                  },
          });
        },
      ),
    [token, revision],
  );

  const lockUntil = state.name === "ready" ? (state.lock?.until ?? null) : null;
  useEffect(() => {
    if (!lockUntil) return;
    const remaining = Date.parse(lockUntil) - Date.now();
    if (!Number.isFinite(remaining)) return;
    const timer = setTimeout(
      () => dispatch({ type: "lock-expired" }),
      Math.min(Math.max(remaining, 0), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [lockUntil]);

  const submit = useCallback(async () => {
    if (state.name !== "ready") return;
    // Take the digits out of state first: the screen is cleared the instant the request starts.
    const attempt = pin;
    setPin("");
    await runApproval(
      { gate, dispatch, deps: CONFIRM_DEPS },
      { token, method: state.method, pin: attempt },
    );
  }, [gate, pin, state, token]);

  return { state, pin, setPin, submit, reload };
}
