"use client";
import { generateRecoveryCode } from "../lib/recovery-code";
import { ActionButton } from "./application/action-button";
import { AuthenticatorEnroller } from "./authenticator-enroller";
import { RecoveryEmailStep } from "./recovery-email-step";
import { RecoveryNeeds } from "./recovery-needs";
import type { useRecoveryCode } from "./use-recovery-code";
export function RecoveryCodeIntro({
  token,
  controller,
}: {
  token: string;
  controller: ReturnType<typeof useRecoveryCode>;
}) {
  const { step, setStep, reload } = controller;
  return (
    <>
      {step.name === "email" && (
        <>
          <RecoveryNeeds />
          <RecoveryEmailStep token={token} onDone={reload} />
        </>
      )}
      {step.name === "authenticator" && (
        <>
          <RecoveryNeeds />
          <AuthenticatorEnroller token={token} onDone={() => setStep({ name: "intro" })} />
        </>
      )}
      {step.name === "intro" && (
        <>
          <RecoveryNeeds />
          <p className="text-sm text-app-muted">
            Kaada never sees your Recovery Code. Write it down and keep it away from your phone.
          </p>
          <ActionButton onClick={() => setStep({ name: "show", code: generateRecoveryCode() })}>
            Create Recovery Code
          </ActionButton>
        </>
      )}
    </>
  );
}
