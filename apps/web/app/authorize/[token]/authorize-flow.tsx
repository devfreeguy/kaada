"use client";

import { useCallback, useEffect, useState } from "react";

import { PinKeypad } from "../../components/pin-keypad";
import { FinalPricing } from "./final-pricing";
import { loggedFetch, logFailure } from "../../lib/client-log";
import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
import type { RootChallenge } from "../../lib/root-proof";

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
  | { name: "ready"; view: View; method: Method }
  | { name: "submitting"; view: View; method: Method }
  | { name: "done"; method: Method }
  | { name: "blocked"; reason: "no-pin" | "reset" };

/** The token goes in a header, never in a body or query; the PIN goes only in the body of one POST. */
async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return loggedFetch(`/api/v1/authorization${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

/** How long a lock still has to run, in words, or null if there is no lock (computed in handlers, never in render). */
function lockText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "about a minute" : `${minutes} minutes`;
}

/** Which way to confirm. Anything unexpected means the PIN, which always works. */
async function methodFor(token: string): Promise<Method> {
  try {
    const response = await call(token, "/root/method");
    if (!response.ok) return "PIN";
    const body = (await response.json()) as { method?: string; rootType?: string };
    if (body.method !== "ROOT") return "PIN";
    return body.rootType === "PASSKEY"
      ? "PASSKEY"
      : body.rootType === "DEVICE_KEY"
        ? "DEVICE_KEY"
        : "PIN";
  } catch (error) {
    logFailure("authorize.method_failed", error);
    return "PIN";
  }
}

export function AuthorizeFlow({ token }: { token: string }) {
  const [state, setState] = useState<State>({ name: "loading" });
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: State;
      let lock: string | null = null;
      try {
        const response = await call(token, "");
        if (!response.ok) {
          next = { name: "invalid" };
        } else {
          const view = (await response.json()) as View;
          lock = lockText(view.pin.lockedUntil);
          const method = await methodFor(token);
          // A passkey replaces the PIN, so a missing PIN only blocks the ways that use one.
          next =
            method !== "PASSKEY" && !view.pin.isSet
              ? { name: "blocked", reason: "no-pin" }
              : method !== "PASSKEY" && view.pin.resetRequired
                ? { name: "blocked", reason: "reset" }
                : { name: "ready", view, method };
        }
      } catch (error) {
        logFailure("authorize.load_failed", error);
        next = { name: "invalid" };
      }
      if (cancelled) return;
      setLocked(lock);
      setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

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
        setLocked(lockText(body["lockedUntil"] as string | undefined));
        setMessage("Too many wrong attempts. Please try again later.");
      } else if (code === "INVALID_PIN") {
        const left = body["attemptsRemaining"] as number | undefined;
        setMessage(
          left !== undefined && left > 0
            ? `That PIN is incorrect. ${left} ${left === 1 ? "attempt" : "attempts"} left.`
            : "That PIN is incorrect.",
        );
      } else if (response.status === 429) {
        setMessage("Too many attempts. Wait a moment and try again.");
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
        setMessage(typeof body["message"] === "string" ? body["message"] : "Nothing was sent.");
      } else {
        setMessage("Something went wrong. Please try again.");
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
        const response = await call(token, "/authorize", {
          method: "POST",
          body: JSON.stringify({ pin: attempt }),
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (interpret(response, body, ready)) setState({ name: "done", method });
        return;
      }

      // The wallet's own root signs the payment itself. The server fixes what is signed; this page only shows the prompt.
      const options = await call(token, "/root/options", { method: "POST" });
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
      const response = await call(token, "/root/confirm", {
        method: "POST",
        body: JSON.stringify({
          operation,
          proof,
          ...(method === "DEVICE_KEY" && { pin: attempt }),
        }),
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
            : "We couldn't reach Kaada. Please try again.",
      );
      setState(ready);
    }
  }, [interpret, pin, state, token]);

  const view = state.name === "ready" || state.name === "submitting" ? state.view : null;
  const method: Method =
    state.name === "ready" || state.name === "submitting" ? state.method : "PIN";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      <p className="text-sm font-semibold tracking-wide text-neutral-500">Kaada</p>

      {state.name === "loading" && <p className="text-neutral-600">Checking your link...</p>}

      {state.name === "invalid" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This link has expired</h1>
          <p className="text-neutral-600">
            For your security, authorization links work once and only for a few minutes. Go back to
            your chat and ask Kaada for a new one. Nothing was sent.
          </p>
        </section>
      )}

      {state.name === "blocked" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">
            {state.reason === "no-pin" ? "Create your PIN first" : "Your PIN needs a reset"}
          </h1>
          <p className="text-neutral-600">
            {state.reason === "no-pin"
              ? "You need a 6-digit PIN to authorize payments. Ask Kaada for a wallet security link to create it."
              : "Your PIN can only be replaced through account recovery. Nothing was sent."}
          </p>
        </section>
      )}

      {view && (
        <section className="flex flex-col gap-5">
          <h1 className="text-2xl font-semibold">
            {method === "PASSKEY" ? "Confirm payment" : "Authorize payment"}
          </h1>

          <dl className="flex flex-col gap-3 rounded-2xl bg-neutral-50 p-4 text-base">
            <div>
              <dt className="text-sm text-neutral-500">
                {view.summary.recipient
                  ? `${view.summary.recipient} receives`
                  : "Recipient receives"}
              </dt>
              <dd className="text-xl font-semibold">
                {view.summary.amountMode === "EXACT_OUTPUT"
                  ? `exactly ${view.summary.recipientReceives.display}`
                  : `about ${view.summary.recipientReceives.display}`}
              </dd>
              {view.summary.amountMode === "EXACT_INPUT" && (
                <dd className="text-sm text-neutral-500">
                  at least {view.summary.minimumReceive.display}
                </dd>
              )}
            </div>
            <div>
              <dt className="text-sm text-neutral-500">Maximum spend</dt>
              <dd className="text-xl font-semibold">{view.summary.maximumSpend.display}</dd>
              {view.summary.amountMode === "EXACT_OUTPUT" && (
                <dd className="text-sm text-neutral-500">
                  estimated {view.summary.senderSpends.display}
                </dd>
              )}
            </div>
          </dl>

          <p className="text-xs text-neutral-500">
            This price is an estimate. Final exchange pricing will be confirmed immediately before
            payment, and it can never exceed the maximum above.
          </p>

          {locked ? (
            <p role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Too many wrong attempts. Try again in {locked}.
            </p>
          ) : (
            <>
              {message && (
                <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
                  {message}
                </p>
              )}
              {method === "PASSKEY" ? (
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={state.name === "submitting"}
                  className="rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white disabled:opacity-40"
                >
                  {state.name === "submitting"
                    ? "Waiting for your passkey..."
                    : "Confirm with passkey"}
                </button>
              ) : (
                <PinKeypad
                  value={pin}
                  onChange={setPin}
                  onSubmit={() => void submit()}
                  disabled={state.name === "submitting"}
                />
              )}
            </>
          )}
        </section>
      )}

      {state.name === "done" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">
            {state.method === "PIN" ? "Payment authorized" : "Payment confirmed"}
          </h1>
          <p className="text-neutral-600">
            {state.method === "PIN"
              ? "Your approval is saved. The final price is confirmed first, and the payment starts only within the limits you just approved. Keep this page open to follow it; you can also return to your chat."
              : "Your payment is on its way. Keep this page open to follow it; you can also return to your chat."}
          </p>
          <FinalPricing token={token} alreadySent={state.method !== "PIN"} />
        </section>
      )}
    </main>
  );
}
