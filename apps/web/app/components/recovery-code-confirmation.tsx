"use client";
import { formatRecoveryCode, parseRecoveryCode } from "../lib/recovery-code";
import { ActionButton } from "./application/action-button";
import { StatusNote } from "./application/status-note";
import { TextField } from "./application/text-field";
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
          <p className="text-sm text-app-muted">Write this down now. It’s shown only once.</p>
          <p
            aria-label="Your Recovery Code"
            className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-4 text-center font-mono text-lg tracking-wide select-all"
          >
            {formatRecoveryCode(step.code)}
          </p>
          <ActionButton
            onClick={() => {
              setTyped("");
              setStep({ name: "confirm", code: step.code, mismatch: false });
            }}
          >
            I’ve written it down
          </ActionButton>
        </>
      )}
      {step.name === "confirm" && (
        <>
          <TextField
            label="Type the code back"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            mono
          />
          {step.mismatch && (
            <StatusNote tone="danger">That doesn’t match. Check what you wrote.</StatusNote>
          )}
          <ActionButton
            onClick={() => {
              if (parseRecoveryCode(typed) === step.code) {
                const code = step.code;
                setTyped("");
                void arm(code);
              } else {
                setStep({ ...step, mismatch: true });
              }
            }}
          >
            Confirm and save
          </ActionButton>
        </>
      )}
    </>
  );
}
