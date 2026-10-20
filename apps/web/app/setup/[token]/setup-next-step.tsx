"use client";
import { useCallback, useState } from "react";
import { RecoveryCodeCreator } from "../../components/recovery-code-creator";
import { primaryAction } from "../../components/application/styles";
import { TELEGRAM_BOT_URL } from "../../lib/site";
import { PinSetup } from "./pin-setup";

export function SetupNextStep({ token, funded }: { token: string; funded: boolean }) {
  const [pinComplete, setPinComplete] = useState(false);
  const finishPin = useCallback(() => setPinComplete(true), []);
  if (!pinComplete) return <PinSetup token={token} onDone={finishPin} />;
  if (funded) return <RecoveryCodeCreator token={token} standalone />;
  return (
    <section className="flex flex-col gap-4">
      <h1>Setup complete</h1>
      <p className="text-white/75">You can return to your chat.</p>
      <a href={TELEGRAM_BOT_URL} className={primaryAction}>
        Back to Kaada
      </a>
    </section>
  );
}
