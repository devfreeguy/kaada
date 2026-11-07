"use client";
import { FlowSection } from "../../components/application/flow-section";
import { FlowStatus } from "../../components/application/flow-status";
import { VerificationStep } from "../../components/application/verification-step";
import { rootContextOf, verifiedCopy } from "../../lib/app-copy";
import { useRootAction } from "./use-root-action";
import type { View } from "./use-root-action";

export function RootActionFlow({ token }: { token: string }) {
  const { view, confirm, reload } = useRootAction({ token });
  return <RootActionScreen view={view} confirm={confirm} reload={reload} />;
}

/** What the person sees for each state of the extra security check. Pure: the same state always draws the same screen. */
export function RootActionScreen({
  view,
  confirm,
  reload,
}: {
  view: View;
  confirm: () => void | Promise<void>;
  reload: () => void;
}) {
  switch (view.name) {
    case "loading":
      return <FlowStatus kind="loading" subject="request" />;
    case "invalid":
      return <FlowStatus kind="unavailable" subject="request" />;
    case "load-error":
      return (
        <FlowStatus kind="load-failed" subject="request" message={view.message} onRetry={reload} />
      );
    case "done": {
      // What was verified and where the update will arrive: never a setup, and never a claim about the payment's outcome.
      const done = verifiedCopy(rootContextOf(view.operation), view.method);
      return <FlowSection title={done.title} description={done.description} />;
    }
    case "ready":
    case "confirming":
      return (
        <VerificationStep
          context={rootContextOf(view.operation)}
          method={view.action === "ROOT_PASSKEY_REQUIRED" ? "passkey" : "device"}
          hint={view.message}
          waiting={view.name === "confirming"}
          notice={view.name === "ready" ? view.notice : undefined}
          onConfirm={() => void confirm()}
        />
      );
  }
}
