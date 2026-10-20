"use client";
import { formatRecoveryCode, parseRecoveryCode } from "../lib/recovery-code";
import { primaryAction } from "./application/styles";
import { RecoveryNeeds } from "./recovery-needs";
import type { useRecoveryCode } from "./use-recovery-code";
export function RecoveryCodeConfirmation({
  controller,
}: {
  controller: ReturnType<typeof useRecoveryCode>;
}) {
  const { step, typed, setTyped, setStep, arm } = controller;
  return (
    <>
      {step.name === "show" && (
        <>
          <p className="text-sm text-white/75">
            Write this code down now. It is shown only once and cannot be recovered.
          </p>
          <p
            aria-label="Your Recovery Code"
            className="rounded-lg bg-white/8 px-4 py-4 text-center font-mono text-lg tracking-wide select-all"
          >
            {formatRecoveryCode(step.code)}
          </p>
          <button
            type="button"
            onClick={() => {
              setTyped("");
              setStep({ name: "confirm", code: step.code, mismatch: false });
            }}
            className={primaryAction}
          >
            I have written it down
          </button>
        </>
      )}
      {step.name === "confirm" && (
        <>
          <p className="text-sm text-white/75">Type the code back to make sure it is right.</p>
          <RecoveryNeeds />
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            aria-label="Type your Recovery Code"
            className="rounded-lg border border-white/25 px-4 py-3 font-mono"
          />
          {step.mismatch && (
            <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
              That doesn&apos;t match. Check what you wrote and try again.
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              if (parseRecoveryCode(typed) === step.code) {
                const code = step.code;
                setTyped("");
                void arm(code);
              } else {
                setStep({ ...step, mismatch: true });
              }
            }}
            className={primaryAction}
          >
            Confirm and save
          </button>
        </>
      )}
    </>
  );
}
