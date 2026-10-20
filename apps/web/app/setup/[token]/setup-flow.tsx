"use client";
import { SetupCredentialStep } from "./setup-credential-step";
import { SetupFinalizeStep } from "./setup-finalize-step";
import { SetupLinkStatus } from "./setup-link-status";
import { SetupNextStep } from "./setup-next-step";
import { useSetup } from "./use-setup";
export function SetupFlow({ token }: { token: string }) {
  const controller = useSetup({ token });
  const { view, funded, finish, reload } = controller;
  if (
    view.name === "loading" ||
    view.name === "invalid" ||
    (view.name === "error" && view.retry === "load")
  )
    return <SetupLinkStatus view={view} onReload={reload} />;
  if (view.name === "done") return <SetupNextStep token={token} funded={funded} />;
  if (
    view.name === "finish" ||
    (view.name === "creating" && view.action === "finish") ||
    (view.name === "error" && view.retry === "finish")
  )
    return (
      <SetupFinalizeStep
        busy={view.name === "creating"}
        message={view.name === "error" ? view.message : undefined}
        onFinish={finish}
      />
    );
  return <SetupCredentialStep {...controller} />;
}
