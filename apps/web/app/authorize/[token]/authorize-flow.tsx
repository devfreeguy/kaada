"use client";
import { FlowSection } from "../../components/application/flow-section";
import { FlowStatus } from "../../components/application/flow-status";
import { StatusNote } from "../../components/application/status-note";
import { VerificationStep } from "../../components/application/verification-step";
import { PinKeypad } from "../../components/pin-keypad";
import { failureCopy, paymentDoneCopy } from "../../lib/app-copy";
import type { VerifyMethod } from "../../lib/app-copy";
import type { Method } from "./authorization-machine";
import { FinalPricing } from "./final-pricing";
import { PaymentSummary } from "./payment-summary";
import { useAuthorization } from "./use-authorization";

const VERIFY_METHOD: Record<Method, VerifyMethod> = {
  PASSKEY: "passkey",
  DEVICE_KEY: "device",
  PIN: "pin",
};

const RECOVERY_HINT: Record<Exclude<Method, "PIN">, string> = {
  PASSKEY: "Passkey not working?",
  DEVICE_KEY: "Lost this device?",
};

export function AuthorizeFlow({ token }: { token: string }) {
  const { state, pin, setPin, submit, reload } = useAuthorization({ token });

  switch (state.name) {
    case "loading":
      return <FlowStatus kind="loading" subject="payment" />;
    case "invalid":
      return <FlowStatus kind="expired" subject="payment" />;
    case "load-error":
      return (
        <FlowStatus kind="load-failed" subject="payment" message={state.message} onRetry={reload} />
      );
    case "blocked":
      return state.reason === "no-pin" ? (
        <FlowSection
          title="Create your PIN first"
          description="Ask Kaada in your chat for a security link."
        />
      ) : (
        <FlowSection
          title="Reset your PIN"
          description="A PIN can only be replaced through recovery. Nothing was sent."
        />
      );
    case "done":
      return (
        <FlowSection
          title={state.method === "PASSKEY" ? paymentDoneCopy.passkey : paymentDoneCopy.pin}
          description={paymentDoneCopy.leave}
        >
          <FinalPricing token={token} alreadySent={state.method !== "PIN"} />
        </FlowSection>
      );
    case "ready":
    case "submitting": {
      const submitting = state.name === "submitting";
      const method = state.method;
      const lock = state.name === "ready" ? state.lock : null;
      const notice = state.name === "ready" ? state.notice : null;
      const recovery =
        method === "PIN" ? null : (
          <p className="text-sm text-app-muted">
            {RECOVERY_HINT[method]}{" "}
            <a href="/recovery" className="text-app-text underline underline-offset-4">
              Recover your wallet
            </a>
          </p>
        );
      return (
        <VerificationStep
          context="payment"
          method={VERIFY_METHOD[method]}
          waiting={submitting}
          notice={lock ? undefined : notice}
          summary={
            <>
              <PaymentSummary summary={state.view.summary} />
              {lock ? (
                <StatusNote tone="warning">{failureCopy.lockedFor(lock.label)}</StatusNote>
              ) : null}
            </>
          }
          onConfirm={() => void submit()}
          actionHidden={lock !== null}
          footer={recovery}
        >
          {method === "PASSKEY" ? undefined : (
            <PinKeypad
              value={pin}
              onChange={setPin}
              onSubmit={() => void submit()}
              disabled={submitting}
              submitLabel="Confirm"
            />
          )}
        </VerificationStep>
      );
    }
  }
}
