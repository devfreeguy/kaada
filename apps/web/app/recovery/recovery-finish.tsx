"use client";
import { RecoveryCodeCreator } from "../components/recovery-code-creator";
import type { useRecovery } from "./use-recovery";

export function RecoveryFinish({ token, refresh, status }: ReturnType<typeof useRecovery>) {
  const step = status?.nextStep;
  return (
    <>
      {step === "CREATE_RECOVERY_CODE" && token && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Last step: set up recovery again</h1>
          <p className="text-white/75">
            Your old Recovery Code and authenticator app were used up by this recovery. Link a new
            authenticator app and create a new Recovery Code to protect your wallet again.
          </p>
          <RecoveryCodeCreator token={token} onDone={() => void refresh(token)} />
        </section>
      )}
    </>
  );
}
