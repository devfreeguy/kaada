"use client";
import { AppAlert as Alert } from "../components/application/app-alert";
import { PinKeypad } from "../components/pin-keypad";
import { usePinReset } from "./use-pin-reset";
export function PinReset({ token, onDone }: { token: string; onDone: () => void }) {
  const { first, value, setValue, message, working, submit } = usePinReset({ token, onDone });
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">
        {first === null ? "Set a new 6-digit PIN" : "Enter it again"}
      </h1>
      <p className="text-white/75">
        Your PIN approves payments on Kaada. Your old PIN no longer works.
      </p>
      {message && <Alert>{message}</Alert>}
      <PinKeypad
        value={value}
        onChange={setValue}
        onSubmit={() => void submit()}
        disabled={working}
        submitLabel={first === null ? "Next" : "Save"}
      />
    </section>
  );
}
