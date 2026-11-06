"use client";
import { useState } from "react";
import { ActionButton } from "../../components/application/action-button";
import { RecoveryCodeCreator } from "../../components/recovery-code-creator";
import { SecurityActionMenu } from "./security-action-menu";
import { SecurityCredentialStep } from "./security-credential-step";
import type { SecurityAction } from "./security-actions";
import { useSecurity } from "./use-security";
export function SecurityFlow({
  token,
  initialAction = null,
}: {
  token: string;
  initialAction?: SecurityAction | null;
}) {
  const [action, setAction] = useState(initialAction);
  const controller = useSecurity({ token });
  if (!action) return <SecurityActionMenu onSelect={setAction} />;
  return (
    <div className="flex flex-col gap-6">
      {action === "recovery" ? (
        <RecoveryCodeCreator token={token} standalone />
      ) : (
        <SecurityCredentialStep action={action} controller={controller} />
      )}
      <ActionButton
        variant="quiet"
        disabled={controller.busy}
        onClick={() => {
          controller.reset();
          setAction(null);
        }}
      >
        Back
      </ActionButton>
    </div>
  );
}
