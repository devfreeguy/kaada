"use client";
import { ActionButton } from "../../components/application/action-button";
import { FlowSection } from "../../components/application/flow-section";
import { StatusNote } from "../../components/application/status-note";

export function SetupFinalizeStep({
  busy,
  message,
  onFinish,
}: {
  busy: boolean;
  message?: string | undefined;
  onFinish: () => Promise<void>;
}) {
  return (
    <FlowSection title="Almost done" description="One last step to create your wallet.">
      {message ? <StatusNote tone="warning">{message}</StatusNote> : null}
      <ActionButton busy={busy} busyLabel="Finishing…" onClick={() => void onFinish()}>
        Finish setup
      </ActionButton>
    </FlowSection>
  );
}
