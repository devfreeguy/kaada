"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeError, json } from "../../lib/api";
import { failureCopy } from "../../lib/app-copy";
import { logFailure } from "../../lib/client-log";
import { observeRequest } from "../../lib/observe-request";
import type { RootChallenge } from "../../lib/root-proof";
import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
import { useOperation } from "../../lib/use-operation";

type RootAction = "ROOT_PASSKEY_REQUIRED" | "ROOT_DEVICE_KEY_REQUIRED";
export type View =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "load-error"; message: string }
  | { name: "ready"; message: string; action: RootAction; notice?: string }
  | { name: "confirming"; message: string; action: RootAction }
  | { name: "done" };

/**
 * Wallet setup that needs the person's ROOT (creating the account and installing the restricted permission for one payment).
 * The server decides exactly what is signed and which signer the wallet has: the page shows a sentence and the matching prompt
 * (a passkey, or this device's key), sends back the root's proof and nothing else, and never asks for the PIN.
 *
 * A failed attempt returns to `ready` with its notice INSIDE that state, and every attempt runs through the operation gate: a
 * second tap sends nothing, a late answer is dropped, and a completed setup can never be replaced by a failure.
 */
async function loadRootAction(token: string): Promise<View> {
  const body = await json<{ message: string; action: RootAction }>(
    await api("/root-action/view", token),
  );
  if (body.action !== "ROOT_PASSKEY_REQUIRED" && body.action !== "ROOT_DEVICE_KEY_REQUIRED")
    throw new Error("Unsupported root action");
  return { name: "ready", message: body.message, action: body.action };
}

export function useRootAction({ token }: { token: string }) {
  const [view, setView] = useState<View>({ name: "loading" });
  const [revision, setRevision] = useState(0);
  const gate = useOperation();

  const reload = useCallback(() => {
    gate.reset();
    setView({ name: "loading" });
    setRevision((value) => value + 1);
  }, [gate]);

  useEffect(
    () =>
      observeRequest(
        () => loadRootAction(token),
        (loaded) => setView((current) => (current.name === "loading" ? loaded : current)),
        (error) => {
          logFailure("root_action.load_failed", error);
          setView((current) =>
            current.name !== "loading"
              ? current
              : error instanceof ApiError && error.kind === "invalid"
                ? { name: "invalid" }
                : {
                    name: "load-error",
                    message: describeError(error, "Couldn't load this request."),
                  },
          );
        },
      ),
    [token, revision],
  );

  const confirm = useCallback(async () => {
    if (view.name !== "ready") return;
    const { action, message } = view;
    const operation = gate.begin();
    if (!operation) return;
    setView({ name: "confirming", action, message });
    const fail = (notice: string) =>
      operation.commit(() => setView({ name: "ready", action, message, notice }));
    try {
      const options = await api("/root-action/options", token);
      if (options.status === 401) {
        operation.commit(() => setView({ name: "invalid" }));
        return;
      }
      if (!options.ok) throw new Error("options");
      const proof = await proveRoot((await options.json()) as RootChallenge);
      const response = await api("/root-action/complete", token, {
        method: "POST",
        body: { proof },
      });
      if (response.status === 401) {
        operation.commit(() => setView({ name: "invalid" }));
        return;
      }
      if (!response.ok) throw new Error("complete");
      operation.succeed(() => setView({ name: "done" }));
    } catch (error) {
      logFailure("root_action.register_failed", error);
      // Cancelling the prompt is the person's choice, and certain: nothing was submitted.
      const cancelled = error instanceof Error && error.name === "NotAllowedError";
      fail(
        error instanceof DeviceKeyMissingError
          ? failureCopy.deviceKeyMissing
          : cancelled
            ? failureCopy.cancelled
            : failureCopy.unknownRequest,
      );
    } finally {
      operation.finish();
    }
  }, [gate, token, view]);

  return { view, confirm, reload };
}
