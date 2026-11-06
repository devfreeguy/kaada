"use client";
import { FlowSection } from "../components/application/flow-section";
import { RecoveryCodeCreator } from "../components/recovery-code-creator";
import type { useRecovery } from "./use-recovery";

export function RecoveryFinish({ token, refresh, status }: ReturnType<typeof useRecovery>) {
  if (status?.nextStep !== "CREATE_RECOVERY_CODE" || !token) return null;
  return (
    <FlowSection
      title="Set up recovery again"
      description="Your old Recovery Code and authenticator app were used up. Create new ones to protect your wallet."
    >
      <RecoveryCodeCreator token={token} onDone={() => void refresh(token)} />
    </FlowSection>
  );
}
