"use client";
import { useCallback, useState } from "react";
import { api, describeError, json } from "../../lib/api";
import { logFailure } from "../../lib/client-log";
import { newDeviceKey, registerPasskey } from "../../lib/new-root";
import type { RootChallenge } from "../../lib/root-proof";
import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
type Kind = "ROTATE_ROOT" | "ENROLL_BACKUP";
type NewType = "PASSKEY" | "DEVICE_KEY";
type Progress =
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
/**
 * Change who controls the wallet WITHOUT a recovery: rotate the root to a fresh credential, or add a backup. The server fixes
 * the operation and what is signed; the CURRENT root confirms it (a passkey prompt or this device's key). Nothing secret leaves
 * the browser: a new device key stays non-extractable here, and Kaada gets only public keys and signatures.
 */
import { useBrowserCapabilities } from "../../lib/browser-capabilities";
export function useSecurity({ token }: { token: string }) {
  const capabilities = useBrowserCapabilities();
  const [progress, setProgress] = useState<Progress>({ name: "idle" });
  const check = useCallback(
    async (changeId: string) => {
      try {
        const view = await json<ChangeView>(await api(`/wallet/root/changes/${changeId}`, token));
        if (view.status === "CONFIRMED") setProgress({ name: "confirmed" });
        else if (view.status === "SUBMITTED")
          setProgress({
            name: "pending",
            changeId,
            message: "Your change is still being confirmed. Check again shortly.",
          });
        else
          setProgress({
            name: "error",
            message:
              "This change has not been confirmed. Review your wallet security before starting another change.",
          });
      } catch (error) {
        setProgress({
          name: "pending",
          changeId,
          message: describeError(
            error,
            "We couldn’t check the change yet. Try checking again shortly.",
          ),
        });
      }
    },
    [token],
  );
  const change = useCallback(
    async (kind: Kind, type: NewType) => {
      setProgress({ name: "working", message: "Preparing..." });
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
          setProgress({ name: "working", message: "Create the new passkey on your device..." });
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
        setProgress({ name: "working", message: "Confirm with your current passkey or device..." });
        const proof = await proveRoot(prepared.challenge);
        submittedChange = prepared.changeId;
        let view = await json<ChangeView>(
          await api(`/wallet/root/changes/${prepared.changeId}/complete`, token, {
            body: { proof },
          }),
        );
        // The chain confirms it a moment later: wait (bounded) for the final answer.
        for (let i = 0; i < 20 && view.status === "SUBMITTED"; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          view = await json<ChangeView>(
            await api(`/wallet/root/changes/${prepared.changeId}`, token),
          );
        }
        if (view.status === "CONFIRMED") return setProgress({ name: "done", kind });
        if (view.status === "SUBMITTED") {
          return setProgress({
            name: "pending",
            changeId: prepared.changeId,
            message: "Your change was submitted and is still being confirmed. Check again shortly.",
          });
        }
        setProgress({
          name: "error",
          message: "The change did not go through. Nothing was lost; you can try again.",
        });
      } catch (error) {
        logFailure("security.change_failed", error);
        if (submittedChange) {
          setProgress({
            name: "pending",
            changeId: submittedChange,
            message:
              "We couldn’t confirm the result. Check this change’s status before starting another.",
          });
          return;
        }
        setProgress({
          name: "error",
          message:
            error instanceof DeviceKeyMissingError
              ? "This browser doesn't hold your wallet's device key. Open the link on the device you set up."
              : describeError(error, "We couldn’t prepare the change. You can try again."),
        });
      }
    },
    [token],
  );
  const busy = progress.name === "working" || progress.name === "pending";
  const reset = useCallback(() => setProgress({ name: "idle" }), []);
  return { progress, change, check, busy, capabilities, reset };
}
