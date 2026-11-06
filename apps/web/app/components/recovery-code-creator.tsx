"use client";
import { ActionButton } from "./application/action-button";
import { FlowSection } from "./application/flow-section";
import { StatusNote } from "./application/status-note";
import { RecoveryCodeIntro } from "./recovery-code-intro";
import { RecoveryCodeConfirmation } from "./recovery-code-confirmation";
import { useRecoveryCode } from "./use-recovery-code";

export function RecoveryCodeCreator({
  token,
  onDone,
  standalone = false,
}: {
  token: string;
  onDone?: () => void;
  standalone?: boolean;
}) {
  const controller = useRecoveryCode({ token, onDone });
  const { step, reload } = controller;
  return (
    <FlowSection title="Recovery setup" as={standalone ? "h1" : "h2"}>
      {step.name === "loading" && <StatusNote>Loading…</StatusNote>}
      <RecoveryCodeIntro token={token} controller={controller} />
      <RecoveryCodeConfirmation controller={controller} />
      {step.name === "arming" && <StatusNote>Confirm with your passkey or this device…</StatusNote>}
      {step.name === "done" && (
        <StatusNote tone="success">
          Recovery is set up. Keep your Recovery Code and authenticator app safe.
        </StatusNote>
      )}
      {step.name === "error" && (
        <>
          <StatusNote tone="danger">{step.message}</StatusNote>
          <ActionButton variant="secondary" onClick={reload}>
            Start again
          </ActionButton>
        </>
      )}
    </FlowSection>
  );
}
