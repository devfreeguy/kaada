"use client";
import { ActionButton } from "../../components/application/action-button";
import { FlowSection } from "../../components/application/flow-section";
import { FlowStatus } from "../../components/application/flow-status";
import { StatusNote } from "../../components/application/status-note";
import { PinKeypad } from "../../components/pin-keypad";
import { rootPromptCopy } from "../../lib/app-copy";
import { usePinSetup } from "./use-pin-setup";

export function PinSetup({ token, onDone }: { token: string; onDone?: (() => void) | undefined }) {
  const { step, value, setValue, setStep, next, reload } = usePinSetup({ token, onDone });
  if (step.name === "loading") return <FlowStatus kind="loading" subject="setup" />;
  if (step.name === "set") return null;
  if (step.name === "saved") {
    return <FlowSection title="PIN saved" />;
  }
  if (step.name === "working") {
    return (
      <FlowSection title="Verify it's you">
        <StatusNote>{rootPromptCopy[step.method ?? "pending"]}</StatusNote>
      </FlowSection>
    );
  }
  if (step.name === "load-error" || step.name === "error") {
    return (
      <FlowSection title="Create your PIN">
        <StatusNote tone="danger">{step.message}</StatusNote>
        {step.name === "error" ? (
          <ActionButton variant="secondary" onClick={() => setStep({ name: "enter" })}>
            Try again
          </ActionButton>
        ) : (
          <ActionButton variant="secondary" onClick={reload}>
            Check again
          </ActionButton>
        )}
      </FlowSection>
    );
  }
  return (
    <FlowSection
      title={step.name === "confirm" ? "Confirm your PIN" : "Create your PIN"}
      {...(step.name === "enter" && { description: "You'll use it to approve payments." })}
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
