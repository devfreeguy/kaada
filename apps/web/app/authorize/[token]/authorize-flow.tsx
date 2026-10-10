"use client";

import { useCallback, useEffect, useState } from "react";

import { PinKeypad } from "../../components/pin-keypad";
import { FinalPricing } from "./final-pricing";

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

type State =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "ready"; view: View }
  | { name: "submitting"; view: View }
  | { name: "done" }
  | { name: "blocked"; reason: "no-pin" | "reset" };

/** The token goes in a header, never in a body or query; the PIN goes only in the body of one POST. */
async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`/api/v1/authorization${path}`, {
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
          next = !view.pin.isSet
            ? { name: "blocked", reason: "no-pin" }
            : view.pin.resetRequired
              ? { name: "blocked", reason: "reset" }
              : { name: "ready", view };
        }
      } catch {
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

  const submit = useCallback(async () => {
    if (state.name !== "ready") return;
    // Take the digits out of state first: the screen is cleared the instant the request starts.
    const attempt = pin;
    setPin("");
    setMessage(null);
    setState({ name: "submitting", view: state.view });
    try {
      const response = await call(token, "/authorize", {
        method: "POST",
        body: JSON.stringify({ pin: attempt }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
        attemptsRemaining?: number;
        lockedUntil?: string;
      };
      if (response.ok) return setState({ name: "done" });
      if (response.status === 401 && body.code === undefined) return setState({ name: "invalid" });
      if (response.status === 423 || body.lockedUntil) {
        setLocked(lockText(body.lockedUntil));
        setMessage("Too many wrong attempts. Please try again later.");
      } else if (body.code === "INVALID_PIN") {
        setMessage(
          body.attemptsRemaining !== undefined && body.attemptsRemaining > 0
            ? `That PIN is incorrect. ${body.attemptsRemaining} ${body.attemptsRemaining === 1 ? "attempt" : "attempts"} left.`
            : "That PIN is incorrect.",
        );
      } else if (response.status === 429) {
        setMessage("Too many attempts. Wait a moment and try again.");
      } else if (body.code === "PIN_NOT_SET") {
        return setState({ name: "blocked", reason: "no-pin" });
      } else if (body.code === "PIN_RESET_REQUIRED") {
        return setState({ name: "blocked", reason: "reset" });
      } else {
        setMessage("Something went wrong. Please try again.");
      }
      setState({ name: "ready", view: state.view });
    } catch {
      setMessage("We couldn't reach Kaada. Please try again.");
      setState({ name: "ready", view: state.view });
    }
  }, [pin, state, token]);

  const view = state.name === "ready" || state.name === "submitting" ? state.view : null;

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
              ? "You need a 4-digit PIN to authorize payments. Ask Kaada for a wallet security link to create it."
              : "Your PIN can only be replaced through account recovery. Nothing was sent."}
          </p>
        </section>
      )}

      {view && (
        <section className="flex flex-col gap-5">
          <h1 className="text-2xl font-semibold">Authorize payment</h1>

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
              <PinKeypad
                value={pin}
                onChange={setPin}
                onSubmit={() => void submit()}
                disabled={state.name === "submitting"}
              />
            </>
          )}
        </section>
      )}

      {state.name === "done" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">Payment authorized</h1>
          <p className="text-neutral-600">
            Your approval is saved. Nothing has been sent yet: the final price is confirmed first,
            and only within the limits you just approved. You can close this page and return to your
            chat.
          </p>
          <FinalPricing token={token} />
        </section>
      )}
    </main>
  );
}
