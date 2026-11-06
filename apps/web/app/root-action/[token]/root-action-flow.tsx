"use client";
import { FlowSection } from "../../components/application/flow-section";
import { FlowStatus } from "../../components/application/flow-status";
import { VerificationStep } from "../../components/application/verification-step";
import { useRootAction } from "./use-root-action";

export function RootActionFlow({ token }: { token: string }) {
  const { view, confirm, reload } = useRootAction({ token });

  switch (view.name) {
    case "loading":
      return <FlowStatus kind="loading" subject="request" />;
    case "invalid":
      return <FlowStatus kind="expired" subject="request" />;
    case "load-error":
      return (
        <FlowStatus kind="load-failed" subject="request" message={view.message} onRetry={reload} />
      );
    case "done":
      return (
        <FlowSection title="Setup confirmed" description="Return to your payment to continue." />
      );
    case "ready":
    case "confirming":
      return (
        <VerificationStep
          context="wallet-action"
          method={view.action === "ROOT_PASSKEY_REQUIRED" ? "passkey" : "device"}
          hint={view.message}
          waiting={view.name === "confirming"}
          notice={view.name === "ready" ? view.notice : undefined}
          onConfirm={() => void confirm()}
        />
      );
  }
}
