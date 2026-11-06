"use client";
import { ActionButton } from "../../components/application/action-button";
import { FlowSection } from "../../components/application/flow-section";
import { FlowStatus } from "../../components/application/flow-status";
import { StatusNote } from "../../components/application/status-note";
import { PinKeypad } from "../../components/pin-keypad";
import { usePinSetup } from "./use-pin-setup";

export function PinSetup({ token, onDone }: { token: string; onDone?: (() => void) | undefined }) {
  const { step, value, setValue, setStep, next, reload } = usePinSetup({ token, onDone });
  if (step.name === "loading") return <FlowStatus kind="loading" subject="setup" />;
  if (step.name === "set") return null;
  if (step.name === "saved") {
    return <FlowSection title="PIN saved" description="You can return to your chat." />;
  }
  if (step.name === "working") {
    return (
      <FlowSection title="Create your PIN">
        <StatusNote>Confirming it’s you…</StatusNote>
      </FlowSection>
    );
  }
  if (step.name === "load-error" || step.name === "error") {
    return (
      <FlowSection title="Create your PIN">
        <StatusNote tone="danger">{step.message}</StatusNote>
        <ActionButton
          variant="secondary"
          onClick={step.name === "error" ? () => setStep({ name: "enter" }) : reload}
        >
          Try again
        </ActionButton>
      </FlowSection>
    );
  }
  return (
    <FlowSection
      title={step.name === "confirm" ? "Confirm your PIN" : "Create your PIN"}
      description="You'll use it to approve payments."
    >
      <PinKeypad
        value={value}
        onChange={setValue}
        onSubmit={next}
        submitLabel={step.name === "enter" ? "Next" : "Save"}
      />
    </FlowSection>
  );
}
