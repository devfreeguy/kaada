"use client";
import { ActionButton } from "../components/application/action-button";
import { FlowSection } from "../components/application/flow-section";
import { FlowStatus } from "../components/application/flow-status";
import { StatusNote } from "../components/application/status-note";
import { PinReset } from "./pin-reset";
import { RecoveryCredential } from "./recovery-credential";
import { RecoveryEmail } from "./recovery-email";
import { RecoveryFactors } from "./recovery-factors";
import { RecoveryFinish } from "./recovery-finish";
import { RecoveryProof } from "./recovery-proof";
import { RecoveryStart } from "./recovery-start";
import { RecoveryWaiting } from "./recovery-waiting";
import { useRecovery } from "./use-recovery";

export function RecoveryFlow() {
  const controller = useRecovery();
  const { session, status, ready, busy, error, token, refresh, forget } = controller;
  if (!ready) return <FlowStatus kind="loading" subject="request" />;
  const step = status?.nextStep;
  return (
    <div className="flex flex-col gap-5">
      {error && <StatusNote tone="danger">{error}</StatusNote>}
      {error && session && (
        <ActionButton
          variant="secondary"
          disabled={busy}
          onClick={() => void refresh(session.token)}
        >
          Refresh
        </ActionButton>
      )}
      <RecoveryStart {...controller} />
      {session && !status && !error && <FlowStatus kind="loading" subject="request" />}
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
        <FlowSection
          title="Wallet recovered"
          description="This device now controls your wallet. Your PIN, authenticator app and Recovery Code are set."
        >
          <ActionButton variant="secondary" onClick={forget}>
            Close
          </ActionButton>
        </FlowSection>
      )}
      {step === "STOPPED" && (
        <FlowSection
          title="Recovery stopped"
          description="It was cancelled from the device or passkey that controls your wallet. Nothing changed."
        >
          <ActionButton onClick={forget}>Start again</ActionButton>
        </FlowSection>
      )}
      {step === "FAILED" && (
        <FlowSection
          title="Recovery couldn’t continue"
          description={
            status?.blockedReason
              ? "It can’t start right now. Try again later."
              : "Nothing was changed. You can start again."
          }
        >
          <ActionButton onClick={forget}>Start again</ActionButton>
        </FlowSection>
      )}
    </div>
  );
}
