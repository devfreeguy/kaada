"use client";
import { secondaryAction } from "../../components/application/styles";
import { PinKeypad } from "../../components/pin-keypad";
import { usePinSetup } from "./use-pin-setup";
export function PinSetup({ token }: { token: string }) {
  const { step, value, setValue, setStep, next, reload } = usePinSetup({ token });
  if (step.name === "loading") return null;
  return (
    <section className="flex flex-col gap-4 border-t border-white/15 pt-6">
      {step.name === "load-error" && (
        <>
          <p role="alert">{step.message}</p>
          <button type="button" onClick={reload} className={secondaryAction}>
            Reload PIN status
          </button>
        </>
      )}
      {step.name === "set" && <p className="text-sm text-white/75">Your payment PIN is set.</p>}
      {step.name === "saved" && <p className="text-sm text-white/90">PIN saved.</p>}
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
          <h2 className="text-lg font-semibold">
            {step.name === "enter" ? "Create your 6-digit PIN" : "Enter it again"}
          </h2>
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
