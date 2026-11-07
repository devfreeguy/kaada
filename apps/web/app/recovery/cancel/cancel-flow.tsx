"use client";
import { ActionButton } from "../../components/application/action-button";
import { FlowSection } from "../../components/application/flow-section";
import { FlowStatus } from "../../components/application/flow-status";
import { StatusNote } from "../../components/application/status-note";
import { useCancelRecovery } from "./use-cancel-recovery";

export function CancelFlow() {
  const { view, cancelWithRoot } = useCancelRecovery();
  switch (view.name) {
    case "loading":
      return <FlowStatus kind="loading" subject="request" />;
    case "missing":
      return (
        <FlowSection
          title="Link not valid"
          description="Open the link from the recovery email exactly as it was sent. Links work once."
        />
      );
    case "stopped":
      return (
        <FlowSection
          title="Recovery stopped"
          description="Your wallet is unchanged. We’ll email you to confirm."
        />
      );
    case "ready":
    case "working":
    case "error":
      return (
        <FlowSection
          title="Stop a wallet recovery"
          description="Someone asked to recover your wallet. If it wasn’t you, stop it now from the device or passkey you normally use. Stopping never moves funds."
        >
          {view.name === "error" && <StatusNote tone="danger">{view.message}</StatusNote>}
          <ActionButton
            busy={view.name === "working"}
            busyLabel="Confirming…"
            onClick={() => void cancelWithRoot()}
          >
            This wasn’t me. Stop it
          </ActionButton>
        </FlowSection>
      );
  }
}
