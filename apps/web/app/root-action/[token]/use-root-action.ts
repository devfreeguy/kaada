"use client";
import { useEffect, useState } from "react";
import { api, ApiError, describeError, json } from "../../lib/api";
import { logFailure } from "../../lib/client-log";
import type { RootChallenge } from "../../lib/root-proof";
import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
type RootAction = "ROOT_PASSKEY_REQUIRED" | "ROOT_DEVICE_KEY_REQUIRED";
type View =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "load-error"; message: string }
  | { name: "ready"; title: string; message: string; action: RootAction }
  | { name: "confirming"; action: RootAction }
  | { name: "done" }
  | { name: "error"; message: string; action: RootAction };
/** The link token travels in a header only: never in a body, a query string or a log. */
/**
 * Wallet setup that needs the person's ROOT (creating the account and installing the restricted permission for one
 * payment). The server decides exactly what is signed and which signer the wallet has: the page shows a sentence and the
 * matching prompt (a passkey, or this device's key), sends back the root's proof and nothing else, and never asks for the PIN.
 */
import { observeRequest } from "../../lib/observe-request";
async function loadRootAction(token: string): Promise<View> {
  const body = await json<{ title: string; message: string; action: RootAction }>(
    await api("/root-action/view", token),
  );
  if (body.action !== "ROOT_PASSKEY_REQUIRED" && body.action !== "ROOT_DEVICE_KEY_REQUIRED")
    throw new Error("Unsupported root action");
  return { name: "ready", ...body };
}
export function useRootAction({ token }: { token: string }) {
  const [view, setView] = useState<View>({ name: "loading" });
  const [revision, setRevision] = useState(0);
  const reload = () => {
    setView({ name: "loading" });
    setRevision((value) => value + 1);
  };
  useEffect(
    () =>
      observeRequest(
        () => loadRootAction(token),
        setView,
        (error) => {
          logFailure("root_action.load_failed", error);
          setView(
            error instanceof ApiError && error.kind === "invalid"
              ? { name: "invalid" }
              : {
                  name: "load-error",
                  message: describeError(error, "We couldn’t load this request. Try again."),
                },
          );
        },
      ),
    [token, revision],
  );
  async function confirm(action: RootAction) {
    setView({ name: "confirming", action });
    try {
      const options = await api("/root-action/options", token);
      if (options.status === 401) return setView({ name: "invalid" });
      if (!options.ok) throw new Error("options");
      const proof = await proveRoot((await options.json()) as RootChallenge);
      const response = await api("/root-action/complete", token, {
        method: "POST",
        body: { proof },
      });
      if (response.status === 401) return setView({ name: "invalid" });
      if (!response.ok) throw new Error("complete");
      setView({ name: "done" });
    } catch (error) {
      logFailure("root_action.register_failed", error);
      // Cancelling the prompt is the person's choice, not a fault.
      const cancelled = error instanceof Error && error.name === "NotAllowedError";
      setView({
        name: "error",
        action,
        message:
          error instanceof DeviceKeyMissingError
            ? "This browser doesn't hold your wallet's device key. Open the link on the device you set up."
            : cancelled
              ? "Confirmation was cancelled. Nothing was changed; you can try again."
              : "We couldn’t confirm the result. Return to your payment to check its status before trying again.",
      });
    }
  }
  return { view, confirm, reload };
}
