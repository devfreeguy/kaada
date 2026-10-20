"use client";
import { secondaryAction } from "../../components/application/styles";
import { PinKeypad } from "../../components/pin-keypad";
import { usePinSetup } from "./use-pin-setup";
export function PinSetup({ token, onDone }: { token: string; onDone?: (() => void) | undefined }) {
  const { step, value, setValue, setStep, next, reload } = usePinSetup({ token, onDone });
  if (step.name === "loading") return <p className="text-white/75">Checking your PIN setup...</p>;
  if (step.name === "set") return null;
  return (
    <section className="flex flex-col gap-4">
      <h1>
        {step.name === "confirm"
          ? "Confirm your payment PIN"
          : step.name === "saved"
            ? "PIN saved"
            : "Create your payment PIN"}
      </h1>
      {step.name === "load-error" && (
        <>
          <p role="alert">{step.message}</p>
          <button type="button" onClick={reload} className={secondaryAction}>
            Reload PIN status
          </button>
        </>
      )}
      {step.name === "saved" && (
        <p className="text-sm text-white/90">You can return to your chat.</p>
      )}
      {step.name === "working" && <p className="text-sm text-white/75">Confirming it is you...</p>}
      {step.name === "error" && (
        <>
          <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
            {step.message}
          </p>
          <button
            type="button"
            onClick={() => setStep({ name: "enter" })}
            className={secondaryAction}
          >
            Try again
          </button>
        </>
      )}
      {(step.name === "enter" || step.name === "confirm") && (
        <>
          <p className="text-sm text-white/75">
            Your PIN approves payments on Kaada. It is not a recovery code and does not unlock your
            wallet.
          </p>
          <PinKeypad
            value={value}
            onChange={setValue}
            onSubmit={next}
            submitLabel={step.name === "enter" ? "Next" : "Save"}
          />
        </>
      )}
    </section>
  );
}
