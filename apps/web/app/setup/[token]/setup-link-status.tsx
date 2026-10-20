"use client";
import { primaryAction } from "../../components/application/styles";
import type { useSetup } from "./use-setup";
export function SetupLinkStatus({
  view,
  onReload,
}: {
  view: ReturnType<typeof useSetup>["view"];
  onReload: () => void;
}) {
  if (view.name === "loading")
    return (
      <p role="status" className="text-white/75">
        Checking your link...
      </p>
    );
  if (view.name === "invalid")
    return (
      <section className="flex flex-col gap-3">
        <h1>This link has expired</h1>
        <p className="text-white/75">
          For your security, setup links work once and only for a short time. Go back to your chat
          and ask Kaada for a new one.
        </p>
      </section>
    );
  if (view.name !== "error") return null;
  return (
    <section className="flex flex-col gap-4">
      <h1>Couldn’t load setup</h1>
      <p role="alert" className="text-white/75">
        {view.message}
      </p>
      <button type="button" onClick={onReload} className={primaryAction}>
        Try loading again
      </button>
    </section>
  );
}
