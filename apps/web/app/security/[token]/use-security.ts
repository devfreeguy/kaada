"use client";
import { useCallback, useState } from "react";
import { api, describeError, json } from "../../lib/api";
import { failureCopy } from "../../lib/app-copy";
import { logFailure } from "../../lib/client-log";
import { newDeviceKey, registerPasskey } from "../../lib/new-root";
import type { RootChallenge } from "../../lib/root-proof";
import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
import { useOperation } from "../../lib/use-operation";
import { useBrowserCapabilities } from "../../lib/browser-capabilities";

type Kind = "ROTATE_ROOT" | "ENROLL_BACKUP";
type NewType = "PASSKEY" | "DEVICE_KEY";
export type Progress =
  | { name: "idle" }
  | { name: "confirmed" }
  | { name: "pending"; message: string; changeId: string }
  | { name: "working"; message: string }
  | { name: "done"; kind: Kind }
  | { name: "error"; message: string };
interface PreparedChange {
  changeId: string;
  kind: Kind;
  challenge: RootChallenge;
  newRootType: NewType;
}
interface ChangeView {
  changeId: string;
  status: "PREPARED" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "EXPIRED" | "CANCELLED";
}

const STILL_CONFIRMING = "Still confirming. Check again shortly.";
const UNKNOWN_RESULT =
  "Couldn't confirm the result. Check this change's status before starting another.";

/**
 * Change who controls the wallet WITHOUT a recovery: rotate the root to a fresh credential, or add a backup. The server fixes
 * the operation and what is signed; the CURRENT root confirms it (a passkey prompt or this device's key). Nothing secret leaves
 * the browser: a new device key stays non-extractable here, and Kaada gets only public keys and signatures.
 *
 * Every change and every status check runs through the operation gate. Leaving the current action (`reset`) invalidates the
 * attempt in progress, including its bounded wait for the chain, so it can neither write into the next action's screen nor keep
 * polling after the person has gone.
 */
export function useSecurity({ token }: { token: string }) {
  const capabilities = useBrowserCapabilities();
  const [progress, setProgress] = useState<Progress>({ name: "idle" });
  const gate = useOperation();

  const check = useCallback(
    async (changeId: string) => {
      const operation = gate.begin();
      if (!operation) return;
      try {
        const view = await json<ChangeView>(await api(`/wallet/root/changes/${changeId}`, token));
        if (view.status === "CONFIRMED") {
          operation.succeed(() => setProgress({ name: "confirmed" }));
        } else if (view.status === "SUBMITTED") {
          operation.commit(() =>
            setProgress({ name: "pending", changeId, message: STILL_CONFIRMING }),
          );
        } else {
          operation.commit(() =>
            setProgress({
              name: "error",
              message:
                "This change wasn't confirmed. Review your wallet security before starting another.",
            }),
          );
        }
      } catch (error) {
        operation.commit(() =>
          setProgress({
            name: "pending",
            changeId,
            message: describeError(error, "Couldn't check yet. Try again shortly."),
          }),
        );
      } finally {
        operation.finish();
      }
    },
    [gate, token],
  );

  const change = useCallback(
    async (kind: Kind, type: NewType) => {
      const operation = gate.begin();
      if (!operation) return;
      const show = (next: Progress) => operation.commit(() => setProgress(next));
      show({ name: "working", message: "Preparing…" });
      let submittedChange: string | null = null;
      try {
        let credential: Record<string, unknown>;
        if (type === "PASSKEY") {
          const options = await json<{
            challenge: string;
            rpId: string;
            userId: string;
            userName: string;
          }>(await api("/wallet/root/passkey/options", token, { method: "POST" }));
          show({ name: "working", message: "Create the new passkey on your device…" });
          credential = { type: "PASSKEY", response: await registerPasskey(options) };
        } else {
          const key = await newDeviceKey();
          const options = await json<{ keyId: string; payload: string; challenge: string }>(
            await api("/wallet/root/device-key/options", token, {
              body: { publicKeyX: key.publicKeyX, publicKeyY: key.publicKeyY },
            }),
          );
          const { r, s } = await key.prove(options.payload);
          // Kept BEFORE the server records it: a key lost after the change would lock the wallet.
          await key.keep(options.keyId);
          credential = {
            type: "DEVICE_KEY",
            publicKeyX: key.publicKeyX,
            publicKeyY: key.publicKeyY,
            challenge: options.challenge,
            r,
            s,
          };
        }
        const prepared = await json<PreparedChange>(
          await api("/wallet/root/changes", token, { body: { kind, credential } }),
        );
        show({ name: "working", message: "Confirm with your current passkey or device…" });
        const proof = await proveRoot(prepared.challenge);
        submittedChange = prepared.changeId;
        let view = await json<ChangeView>(
          await api(`/wallet/root/changes/${prepared.changeId}/complete`, token, {
            body: { proof },
          }),
        );
        // The chain confirms it a moment later: wait (bounded) for the final answer, and stop at once if the person left.
        for (let i = 0; i < 20 && view.status === "SUBMITTED"; i += 1) {
          if (!operation.isCurrent()) return;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (!operation.isCurrent()) return;
          view = await json<ChangeView>(
            await api(`/wallet/root/changes/${prepared.changeId}`, token),
          );
        }
        if (view.status === "CONFIRMED") {
          operation.succeed(() => setProgress({ name: "done", kind }));
          return;
        }
        if (view.status === "SUBMITTED") {
          show({
            name: "pending",
            changeId: prepared.changeId,
            message: "Submitted and still confirming. Check again shortly.",
          });
          return;
        }
        show({ name: "error", message: "The change didn't go through. You can try again." });
      } catch (error) {
        logFailure("security.change_failed", error);
        if (submittedChange) {
          show({ name: "pending", changeId: submittedChange, message: UNKNOWN_RESULT });
          return;
        }
        show({
          name: "error",
          message:
            error instanceof DeviceKeyMissingError
              ? failureCopy.deviceKeyMissing
              : describeError(error, "Couldn't prepare the change. You can try again."),
        });
      } finally {
        operation.finish();
      }
    },
    [gate, token],
  );

  const busy = progress.name === "working" || progress.name === "pending";
  /** Leaving this action: whatever was in progress is forgotten and can no longer write to the screen. */
  const reset = useCallback(() => {
    gate.reset();
    setProgress({ name: "idle" });
  }, [gate]);
  return { progress, change, check, busy, capabilities, reset };
}
