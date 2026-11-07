"use client";
import { useCallback, useState } from "react";
import { ActionLink } from "../../components/application/action-button";
import { FlowSection } from "../../components/application/flow-section";
import { RecoveryCodeCreator } from "../../components/recovery-code-creator";
import { TELEGRAM_BOT_URL } from "../../lib/site";
import { PinSetup } from "./pin-setup";

export function SetupNextStep({ token, funded }: { token: string; funded: boolean }) {
  const [pinComplete, setPinComplete] = useState(false);
  const finishPin = useCallback(() => setPinComplete(true), []);
  if (!pinComplete) return <PinSetup token={token} onDone={finishPin} />;
  if (funded) return <RecoveryCodeCreator token={token} standalone />;
  return (
    <FlowSection title="Wallet ready">
      <ActionLink href={TELEGRAM_BOT_URL}>Back to Kaada</ActionLink>
    </FlowSection>
  );
}
