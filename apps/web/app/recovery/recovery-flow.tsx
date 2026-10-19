"use client";
import { RecoveryCredential } from "./recovery-credential";
import { RecoveryEmail } from "./recovery-email";
import { RecoveryFactors } from "./recovery-factors";
import { RecoveryFinish } from "./recovery-finish";
import { RecoveryProof } from "./recovery-proof";
import { RecoveryStart } from "./recovery-start";
import { RecoveryWaiting } from "./recovery-waiting";

import { AppAlert as Alert } from "../components/application/app-alert";
import { primaryAction, secondaryAction } from "../components/application/styles";
import { PinReset } from "./pin-reset";
import { useRecovery } from "./use-recovery";
const button = primaryAction;
const secondary = secondaryAction;
export function RecoveryFlow() {
  const controller = useRecovery();
  const { session, status, ready, busy, error, token, refresh, forget } = controller;
  if (!ready)
    return (
      <p role="status" className="text-white/75">
        Loading...
      </p>
    );
  const step = status?.nextStep;
  return (
    <div className="flex flex-col gap-5">
      {error && <Alert>{error}</Alert>}
      {error && session && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh(session.token)}
          className={secondaryAction}
        >
          Refresh recovery status
        </button>
      )}
      <RecoveryStart {...controller} />
      {session && !status && !error && <p className="text-white/75">Loading...</p>}
      <RecoveryEmail {...controller} />
      <RecoveryCredential {...controller} />
      <RecoveryFactors {...controller} />
      <RecoveryWaiting {...controller} />
      <RecoveryProof {...controller} />
      {step === "RESET_PIN" && token && (
        <PinReset token={token} onDone={() => void refresh(token)} />
      )}
      <RecoveryFinish {...controller} />
      {step === "DONE" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">Your wallet is recovered</h1>
          <p className="text-white/75">
            This device now controls your wallet. Your new PIN, authenticator app and Recovery Code
            are set.
          </p>
          <button type="button" onClick={forget} className={secondary}>
            Close
          </button>
        </section>
      )}
      {step === "STOPPED" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This recovery was stopped</h1>
          <p className="text-white/75">
            It was cancelled from the device or passkey that controls your wallet. Nothing changed.
            You can start again.
          </p>
          <button type="button" onClick={forget} className={button}>
            Start again
          </button>
        </section>
      )}
      {step === "FAILED" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This recovery couldn&apos;t continue</h1>
          <p className="text-white/75">
            {status?.blockedReason
              ? "It can't start right now. Try again later."
              : "Something went wrong. Nothing was changed. You can start again."}
          </p>
          <button type="button" onClick={forget} className={button}>
            Start again
          </button>
        </section>
      )}
    </div>
  );
}
