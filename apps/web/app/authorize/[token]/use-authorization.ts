"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeError, json } from "../../lib/api";
import { logFailure } from "../../lib/client-log";
import { observeRequest } from "../../lib/observe-request";
import type { RootChallenge } from "../../lib/root-proof";
import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
interface MoneyView {
  display: string;
}
interface Summary {
  amountMode: "EXACT_INPUT" | "EXACT_OUTPUT";
  recipient?: string;
  senderSpends: MoneyView;
  maximumSpend: MoneyView;
  recipientReceives: MoneyView;
  minimumReceive: MoneyView;
}
interface View {
  summary: Summary;
  expiresAt: string;
  pin: { isSet: boolean; resetRequired: boolean; lockedUntil?: string };
}
/**
 * How this payment is confirmed, decided by the server from the wallet's own root:
 *  - PASSKEY: one prompt, no PIN (the passkey signs the payment itself);
 *  - DEVICE_KEY: the PIN, then this device's key signs in the background (no second prompt);
 *  - PIN: the PIN alone (a wallet that cannot sign this payment itself).
 */
type Method = "PIN" | "PASSKEY" | "DEVICE_KEY";
type State =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "load-error"; message: string }
  | { name: "ready"; view: View; method: Method }
  | { name: "submitting"; view: View; method: Method }
  | { name: "done"; method: Method }
  | { name: "blocked"; reason: "no-pin" | "reset" };
/** The token goes in a header, never in a body or query; the PIN goes only in the body of one POST. */
/** How long a lock still has to run, in words, or null if there is no lock (computed in handlers, never in render). */
function lockText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "about a minute" : `${minutes} minutes`;
}
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
async function loadAuthorization(token: string): Promise<{ state: State; locked: string | null }> {
  const [view, method] = await Promise.all([
    api("/authorization", token).then(json<View>),
    methodFor(token),
  ]);
  const state: State =
    method !== "PASSKEY" && !view.pin.isSet
      ? { name: "blocked", reason: "no-pin" }
      : method !== "PASSKEY" && view.pin.resetRequired
        ? { name: "blocked", reason: "reset" }
        : { name: "ready", view, method };
  return { state, locked: method === "PASSKEY" ? null : lockText(view.pin.lockedUntil) };
}
export function useAuthorization({ token }: { token: string }) {
  const [state, setState] = useState<State>({ name: "loading" });
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = () => {
    setState({ name: "loading" });
    setRevision((value) => value + 1);
  };
  useEffect(
    () =>
      observeRequest(
        () => loadAuthorization(token),
        (result) => {
          setLocked(result.locked);
          setLockedUntil(
            result.state.name === "ready" ? (result.state.view.pin.lockedUntil ?? null) : null,
          );
          setState(result.state);
        },
        (error) => {
          logFailure("authorize.load_failed", error);
          setState(
            error instanceof ApiError && error.kind === "invalid"
              ? { name: "invalid" }
              : {
                  name: "load-error",
                  message: describeError(error, "We couldn’t load this payment. Please try again."),
                },
          );
        },
      ),
    [token, revision],
  );
  useEffect(() => {
    if (!lockedUntil) return;
    const remaining = Date.parse(lockedUntil) - Date.now();
    if (!Number.isFinite(remaining)) return;
    const timer = setTimeout(
      () => setLocked(null),
      Math.min(Math.max(remaining, 0), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [lockedUntil]);
  /** Turns a failed response into a message (or a different screen). Returns true when the payment went through. */
  const interpret = useCallback(
    (response: Response, body: Record<string, unknown>, ready: State): boolean => {
      if (response.ok) return true;
      const code = body["code"] as string | undefined;
      if (response.status === 401 && code === undefined) {
        setState({ name: "invalid" });
        return false;
      }
      if (response.status === 423 || body["lockedUntil"]) {
        const deadline = typeof body["lockedUntil"] === "string" ? body["lockedUntil"] : null;
        setLocked(lockText(deadline));
        setLockedUntil(deadline);
        setMessage("Too many wrong attempts. Please try again later.");
      } else if (code === "INVALID_PIN") {
        const value = body["attemptsRemaining"];
        const left = typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
        setMessage(
          left !== undefined && left > 0
            ? `That PIN is incorrect. ${left} ${left === 1 ? "attempt" : "attempts"} left.`
            : "That PIN is incorrect.",
        );
      } else if (response.status === 429) {
        setMessage("Too many attempts. Wait a moment and try again.");
      } else if (code === "PIN_REQUIRED") {
        setMessage("Enter your PIN to confirm this payment.");
      } else if (code === "PIN_NOT_SET") {
        setState({ name: "blocked", reason: "no-pin" });
        return false;
      } else if (code === "PIN_RESET_REQUIRED") {
        setState({ name: "blocked", reason: "reset" });
        return false;
      } else if (
        code === "INSUFFICIENT_BALANCE" ||
        code === "GAS_FUNDING_REQUIRED" ||
        code === "NOT_SENT"
      ) {
        // The server's own sentence: it says exactly what is missing and that nothing was sent.
        setMessage(
          code === "INSUFFICIENT_BALANCE"
            ? "Your balance cannot cover this payment and its network fee. Nothing was sent."
            : code === "GAS_FUNDING_REQUIRED"
              ? "Your wallet needs CELO for the network fee. Nothing was sent."
              : "The payment could not be sent. Return to your chat to start it again.",
        );
      } else {
        setMessage(
          "We couldn’t confirm the result. Check your payment in chat before trying again.",
        );
      }
      setState(ready);
      return false;
    },
    [],
  );
  const submit = useCallback(async () => {
    if (state.name !== "ready") return;
    const { view: current, method } = state;
    // Take the digits out of state first: the screen is cleared the instant the request starts.
    const attempt = pin;
    setPin("");
    setMessage(null);
    setState({ name: "submitting", view: current, method });
    const ready: State = { name: "ready", view: current, method };
    try {
      if (method === "PIN") {
        const response = await api("/authorization/authorize", token, {
          method: "POST",
          body: { pin: attempt },
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (interpret(response, body, ready)) setState({ name: "done", method });
        return;
      }
      // The wallet's own root signs the payment itself. The server fixes what is signed; this page only shows the prompt.
      const options = await api("/authorization/root/options", token, { method: "POST" });
      if (!options.ok) {
        const body = (await options.json().catch(() => ({}))) as Record<string, unknown>;
        interpret(options, body, ready);
        return;
      }
      const { challenge, operation } = (await options.json()) as {
        challenge: RootChallenge;
        operation: string;
      };
      const proof = await proveRoot(challenge);
      const response = await api("/authorization/root/confirm", token, {
        method: "POST",
        body: {
          operation,
          proof,
          ...(method === "DEVICE_KEY" && { pin: attempt }),
        },
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (interpret(response, body, ready)) setState({ name: "done", method });
    } catch (error) {
      logFailure("authorize.submit_failed", error);
      // Cancelling the passkey prompt is the person's choice, not a fault.
      const cancelled = error instanceof Error && error.name === "NotAllowedError";
      setMessage(
        error instanceof DeviceKeyMissingError
          ? "This browser doesn't hold your wallet's device key. Open the link on the device you set up."
          : cancelled
            ? "Confirmation was cancelled. Nothing was sent. You can try again."
            : "We couldn’t confirm the result. Check your payment in chat before trying again.",
      );
      setState(ready);
    }
  }, [interpret, pin, state, token]);
  const view = state.name === "ready" || state.name === "submitting" ? state.view : null;
  const method: Method =
    state.name === "ready" || state.name === "submitting" ? state.method : "PIN";
  return { state, pin, setPin, message, locked, submit, view, method, reload };
}
