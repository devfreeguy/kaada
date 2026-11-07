"use client";
import { FlowStatus } from "../../components/application/flow-status";
import { SetupCredentialStep } from "./setup-credential-step";
import { SetupFinalizeStep } from "./setup-finalize-step";
import { SetupNextStep } from "./setup-next-step";
import { SetupUnconfirmedStep } from "./setup-unconfirmed-step";
import { useSetup } from "./use-setup";

export function SetupFlow({ token }: { token: string }) {
  const controller = useSetup({ token });
  const { view, funded, finish, reload } = controller;
  if (view.name === "loading") return <FlowStatus kind="loading" subject="setup" />;
  if (view.name === "invalid") return <FlowStatus kind="unavailable" subject="setup" />;
  if (view.name === "error" && view.retry === "load") {
    return (
      <FlowStatus kind="load-failed" subject="setup" message={view.message} onRetry={reload} />
    );
  }
  // A request went out and its result is unknown: read the wallet's state again before offering anything that could repeat it.
  if (view.name === "error" && view.retry === "check") {
    return <SetupUnconfirmedStep message={view.message} onCheck={reload} />;
  }
  if (view.name === "done") return <SetupNextStep token={token} funded={funded} />;
  if (
    view.name === "finish" ||
    (view.name === "creating" && view.action === "finish") ||
    (view.name === "error" && view.retry === "finish")
  ) {
    return (
      <SetupFinalizeStep
        busy={view.name === "creating"}
        message={view.name === "error" ? view.message : undefined}
        onFinish={finish}
      />
    );
  }
  return <SetupCredentialStep {...controller} />;
}
