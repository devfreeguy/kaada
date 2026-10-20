"use client";
import { secondaryAction } from "./application/styles";
import { RecoveryCodeIntro } from "./recovery-code-intro";
import { RecoveryCodeConfirmation } from "./recovery-code-confirmation";
import { useRecoveryCode } from "./use-recovery-code";

export function RecoveryCodeCreator({
  token,
  onDone,
  standalone = false,
}: {
  token: string;
  onDone?: () => void;
  standalone?: boolean;
}) {
  const Heading = standalone ? "h1" : "h2";
  const controller = useRecoveryCode({ token, onDone });
  const { step, reload } = controller;
  return (
    <section className={`flex flex-col gap-4 ${standalone ? "" : "border-t border-white/15 pt-6"}`}>
      <Heading className={standalone ? "" : "text-lg font-semibold"}>Recovery setup</Heading>
      {step.name === "loading" && <p className="text-sm text-white/75">Loading...</p>}
      <RecoveryCodeIntro token={token} controller={controller} />
      <RecoveryCodeConfirmation controller={controller} />
      {step.name === "arming" && (
        <p className="text-sm text-white/75">Confirm with your passkey or this device...</p>
      )}
      {step.name === "done" && (
        <p className="rounded-lg bg-white/8 px-4 py-3 text-sm text-white/90">
          Recovery is set up. Keep your Recovery Code safe, and keep your authenticator app.
        </p>
      )}
      {step.name === "error" && (
        <>
          <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
            {step.message}
          </p>
          <button type="button" onClick={reload} className={secondaryAction}>
            Start again
          </button>
        </>
      )}
    </section>
  );
}
