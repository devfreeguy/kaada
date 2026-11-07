"use client";
import { ActionButton } from "../../components/application/action-button";
import { FlowSection } from "../../components/application/flow-section";
import { StatusNote } from "../../components/application/status-note";

/**
 * Setup was submitted and the answer was lost. Creating a second passkey or key could leave the wallet with two, so the only
 * action is to read its state again; the page then shows whatever really happened.
 */
export function SetupUnconfirmedStep({
  message,
  onCheck,
}: {
  message: string;
  onCheck: () => void;
}) {
  return (
    <FlowSection title="Setup not confirmed">
      <StatusNote tone="warning">{message}</StatusNote>
      <ActionButton onClick={onCheck}>Check again</ActionButton>
    </FlowSection>
  );
}
