"use client";
import { generateRecoveryCode } from "../lib/recovery-code";
import { primaryAction } from "./application/styles";
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
          <p className="text-sm text-white/75">
            Your Recovery Code is the second part. Kaada never sees it. Write it down and keep it
            somewhere safe, apart from your phone: with it, your authenticator app and your email,
            someone could start a recovery of your wallet.
          </p>
          <button
            type="button"
            onClick={() => setStep({ name: "show", code: generateRecoveryCode() })}
            className={primaryAction}
          >
            Create a new Recovery Code
          </button>
        </>
      )}
    </>
  );
}
