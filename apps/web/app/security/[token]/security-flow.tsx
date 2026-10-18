"use client";

import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useCallback, useState } from "react";

import { RecoveryCodeCreator } from "../../components/recovery-code-creator";
import { api, describeError, json } from "../../lib/api";
import { deviceKeySupported } from "../../lib/device-key";
import { newDeviceKey, registerPasskey } from "../../lib/new-root";
import { DeviceKeyMissingError, proveRoot } from "../../lib/root-proof";
import type { RootChallenge } from "../../lib/root-proof";
import { logFailure } from "../../lib/client-log";

type Kind = "ROTATE_ROOT" | "ENROLL_BACKUP";
type NewType = "PASSKEY" | "DEVICE_KEY";

type Progress =
  | { name: "idle" }
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

const button =
  "rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white disabled:opacity-50";
const secondary = "rounded-xl border border-neutral-300 px-5 py-4 text-base font-medium";

const COPY: Record<Kind, { title: string; intro: string; done: string }> = {
  ROTATE_ROOT: {
    title: "Change the passkey or device that controls your wallet",
    intro:
      "Move control to a new passkey or device key. Your current one confirms the change, and the old one stops working once it is done.",
    done: "Your wallet is now controlled by the new credential. The old one no longer works.",
  },
  ENROLL_BACKUP: {
    title: "Add a backup passkey or device",
    intro:
      "A backup can also control your wallet, so you are not locked out if you lose this device. Your current credential confirms adding it.",
    done: "Your backup is added. Both credentials can now control your wallet.",
  },
};

/**
 * Change who controls the wallet WITHOUT a recovery: rotate the root to a fresh credential, or add a backup. The server fixes
 * the operation and what is signed; the CURRENT root confirms it (a passkey prompt or this device's key). Nothing secret leaves
 * the browser: a new device key stays non-extractable here, and Kaada gets only public keys and signatures.
 */
export function SecurityFlow({ token }: { token: string }) {
  const [progress, setProgress] = useState<Progress>({ name: "idle" });

  const change = useCallback(
    async (kind: Kind, type: NewType) => {
      setProgress({ name: "working", message: "Preparing..." });
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
            name: "error",
            message: "It was sent and is still being confirmed. Check back in a minute.",
          });
        }
        setProgress({
          name: "error",
          message: "The change did not go through. Nothing was lost; you can try again.",
        });
      } catch (error) {
        logFailure("security.change_failed", error);
        setProgress({
          name: "error",
          message:
            error instanceof DeviceKeyMissingError
              ? "This browser doesn't hold your wallet's device key. Open the link on the device you set up."
              : describeError(error, "That didn't work. Nothing was changed; you can try again."),
        });
      }
    },
    [token],
  );

  const busy = progress.name === "working";

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold">Wallet security</h1>

      {progress.name === "error" && (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          {progress.message}
        </p>
      )}
      {progress.name === "working" && <p className="text-neutral-600">{progress.message}</p>}
      {progress.name === "done" && (
        <p className="rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800">
          {COPY[progress.kind].done}
        </p>
      )}

      {(["ROTATE_ROOT", "ENROLL_BACKUP"] as const).map((kind) => (
        <section key={kind} className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{COPY[kind].title}</h2>
          <p className="text-sm text-neutral-600">{COPY[kind].intro}</p>
          {browserSupportsWebAuthn() && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void change(kind, "PASSKEY")}
              className={button}
            >
              {kind === "ROTATE_ROOT" ? "Switch to a new passkey" : "Add a passkey"}
            </button>
          )}
          {deviceKeySupported() && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void change(kind, "DEVICE_KEY")}
              className={secondary}
            >
              {kind === "ROTATE_ROOT"
                ? "Switch to a key on this device"
                : "Add this device as a backup"}
            </button>
          )}
        </section>
      ))}

      <RecoveryCodeCreator token={token} />
    </div>
  );
}
