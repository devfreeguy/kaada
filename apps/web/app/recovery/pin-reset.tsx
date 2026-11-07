"use client";
import { FlowSection } from "../components/application/flow-section";
import { StatusNote } from "../components/application/status-note";
import { PinKeypad } from "../components/pin-keypad";
import { usePinReset } from "./use-pin-reset";

export function PinReset({ token, onDone }: { token: string; onDone: () => void }) {
  const { first, value, setValue, message, working, submit } = usePinReset({ token, onDone });
  return (
    <FlowSection
      title={first === null ? "Set a new PIN" : "Confirm your new PIN"}
      {...(first === null && {
        description: "You’ll use it to approve payments. Your old PIN no longer works.",
      })}
    >
      {message && <StatusNote tone="danger">{message}</StatusNote>}
      <PinKeypad
        value={value}
        onChange={setValue}
        onSubmit={() => void submit()}
        disabled={working}
        submitLabel={first === null ? "Next" : "Save"}
      />
    </FlowSection>
  );
}
