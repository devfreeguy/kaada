"use client";
import { rootPromptCopy } from "../lib/app-copy";
import { ActionButton } from "./application/action-button";
import { FlowSection } from "./application/flow-section";
import { StatusNote } from "./application/status-note";
import { RecoveryCodeIntro } from "./recovery-code-intro";
import { RecoveryCodeConfirmation } from "./recovery-code-confirmation";
import { useRecoveryCode } from "./use-recovery-code";

/**
 * Setting up recovery. On its own page it has its own heading; inside another screen (recovery's "Set up recovery again") that
 * screen already names the task, so the steps are shown without a second heading.
 */
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
  const body = (
    <>
      {step.name === "loading" && <StatusNote>Loading…</StatusNote>}
      <RecoveryCodeIntro token={token} controller={controller} />
      <RecoveryCodeConfirmation controller={controller} />
      {step.name === "arming" && (
        <StatusNote>{rootPromptCopy[step.method ?? "pending"]}</StatusNote>
      )}
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
    </>
  );
  return standalone ? (
    <FlowSection title="Recovery setup">{body}</FlowSection>
  ) : (
    <div className="flex flex-col gap-4">{body}</div>
  );
}
