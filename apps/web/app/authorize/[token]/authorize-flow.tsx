"use client";
import { primaryAction } from "../../components/application/styles";
import { PinKeypad } from "../../components/pin-keypad";
import { FinalPricing } from "./final-pricing";
import { useAuthorization } from "./use-authorization";
export function AuthorizeFlow({ token }: { token: string }) {
  const { state, pin, setPin, message, locked, submit, view, method, reload } = useAuthorization({
    token,
  });
  return (
    <div className="flex flex-col gap-6">
      {state.name === "loading" && <p className="text-white/75">Checking your link...</p>}
      {state.name === "load-error" && (
        <section className="flex flex-col gap-4">
          <h1>Payment unavailable</h1>
          <p role="alert" className="text-white/75">
            {state.message}
          </p>
          <button type="button" onClick={reload} className={primaryAction}>
            Try loading again
          </button>
        </section>
      )}
      {state.name === "invalid" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This link has expired</h1>
          <p className="text-white/75">
            For your security, authorization links work once and only for a few minutes. Go back to
            your chat and check the payment before asking Kaada for a new link.
          </p>
        </section>
      )}
      {state.name === "blocked" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">
            {state.reason === "no-pin" ? "Create your PIN first" : "Your PIN needs a reset"}
          </h1>
          <p className="text-white/75">
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
          <dl className="flex flex-col gap-3 rounded-2xl bg-white/8 p-4 text-base">
            <div>
              <dt className="text-sm text-white/60">
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
                <dd className="text-sm text-white/60">
                  at least {view.summary.minimumReceive.display}
                </dd>
              )}
            </div>
            <div>
              <dt className="text-sm text-white/60">Maximum spend</dt>
              <dd className="text-xl font-semibold">{view.summary.maximumSpend.display}</dd>
              {view.summary.amountMode === "EXACT_OUTPUT" && (
                <dd className="text-sm text-white/60">
                  estimated {view.summary.senderSpends.display}
                </dd>
              )}
            </div>
          </dl>
          <p className="text-xs text-white/60">
            This price is an estimate. Final exchange pricing will be confirmed immediately before
            payment, and it can never exceed the maximum above.
          </p>
          {locked ? (
            <p role="alert" className="rounded-lg bg-orange/15 px-4 py-3 text-sm text-white">
              Too many wrong attempts. Try again in {locked}.
            </p>
          ) : (
            <>
              {message && (
                <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
                  {message}
                </p>
              )}
              {method === "PASSKEY" ? (
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={state.name === "submitting"}
                  className={primaryAction}
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
              {method !== "PIN" && (
                <p className="text-xs text-white/60">
                  {method === "PASSKEY"
                    ? "Passkey not working, or no longer have this device? "
                    : "No longer have the device this wallet was set up on? "}
                  <a href="/recovery" className="underline">
                    Regain access with account recovery
                  </a>
                  .
                </p>
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
          <p className="text-white/75">
            {state.method === "PIN"
              ? "Your approval is saved. The final price is confirmed first, and the payment starts only within the limits you just approved. Keep this page open to follow it; you can also return to your chat."
              : "Your payment is on its way. Keep this page open to follow it; you can also return to your chat."}
          </p>
          <FinalPricing token={token} alreadySent={state.method !== "PIN"} />
        </section>
      )}
    </div>
  );
}
