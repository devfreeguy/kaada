"use client";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeError, json } from "../../lib/api";
import { failureCopy } from "../../lib/app-copy";
import { logFailure } from "../../lib/client-log";
import {
  deviceKeySupported,
  generateDeviceKey,
  saveDeviceKey,
  signDevicePayload,
} from "../../lib/device-key";
import { observeRequest } from "../../lib/observe-request";
import type { Operation } from "../../lib/operation-gate";
import { useOperation } from "../../lib/use-operation";

interface WalletInfo {
  address: string | null;
  status: string;
}
export type View =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "ready"; deviceKeysEnabled: boolean }
  | { name: "finish" }
  | { name: "creating"; action: "create" | "device" | "finish" }
  | { name: "done"; address: string }
  /**
   * `retry` says what the screen may offer. load: the first read failed. create / device: it failed before anything was sent, so
   * the same action can run again. check: the request went out and its result is unknown, so the only safe step is to read the
   * wallet's state again. finish: the credential is saved and only the last step is left.
   */
  | { name: "error"; message: string; retry: "load" | "check" | "create" | "device" | "finish" };

const SAVED_BUT_UNCONFIRMED = "Your setup is saved, but your wallet isn't confirmed yet.";
const PASSKEY_UNCONFIRMED =
  "We couldn't confirm your setup. Check again before creating another passkey.";
const DEVICE_UNCONFIRMED =
  "We couldn't confirm your setup. Check again before creating another key.";

/** Sends the setup token as a bearer header: it is never put in a body, a query string or a log. */
async function loadSetup(
  token: string,
): Promise<{ deviceKeysEnabled: boolean; funded: boolean; view: View }> {
  const body = await json<{
    rootRegistered: boolean;
    deviceKeysEnabled: boolean;
    funded?: boolean;
    wallet: WalletInfo | null;
  }>(await api("/wallet", token));
  const view: View =
    body.wallet?.status === "ACTIVE" && body.wallet.address
      ? { name: "done", address: body.wallet.address }
      : body.rootRegistered
        ? { name: "finish" }
        : { name: "ready", deviceKeysEnabled: body.deviceKeysEnabled };
  return { deviceKeysEnabled: body.deviceKeysEnabled, funded: body.funded === true, view };
}

/**
 * Wallet setup: create the credential, then finish. Every action runs through the operation gate, so a second tap starts
 * nothing, a late answer from an earlier attempt is dropped, and a wallet that was created can never be replaced on screen by a
 * failure from something that finished after it.
 */
export function useSetup({ token }: { token: string }) {
  const [view, setView] = useState<View>({ name: "loading" });
  const [deviceKeysEnabled, setDeviceKeysEnabled] = useState(false);
  // Securing the account is asked for only once the wallet has received its first funds.
  const [funded, setFunded] = useState(false);
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
        () => loadSetup(token),
        (result) => {
          setDeviceKeysEnabled(result.deviceKeysEnabled);
          setFunded(result.funded);
          setView((current) => (current.name === "loading" ? result.view : current));
        },
        (error) => {
          logFailure("setup.load_failed", error);
          setView((current) =>
            current.name !== "loading"
              ? current
              : error instanceof ApiError && error.kind === "invalid"
                ? { name: "invalid" }
                : {
                    name: "error",
                    message: describeError(error, "Couldn't load your wallet."),
                    retry: "load",
                  },
          );
        },
      ),
    [token, revision],
  );

  const finish = useCallback(async () => {
    const operation = gate.begin();
    if (!operation) return;
    const show = (next: View) => operation.commit(() => setView(next));
    show({ name: "creating", action: "finish" });
    try {
      const response = await api("/wallet/setup/finalize", token, { method: "POST" });
      if (response.status === 401) {
        show({ name: "invalid" });
        return;
      }
      if (!response.ok) throw new Error("failed");
      const body = (await response.json()) as { wallet: WalletInfo | null };
      if (!body.wallet?.address) throw new Error("no wallet");
      const address = body.wallet.address;
      operation.succeed(() => setView({ name: "done", address }));
    } catch (error) {
      logFailure("setup.finish_failed", error);
      show({ name: "error", message: SAVED_BUT_UNCONFIRMED, retry: "finish" });
    } finally {
      operation.finish();
    }
  }, [gate, token]);

  /**
   * The alternative for a browser or phone without passkeys: a P-256 key made by this device. Its private half is
   * non-extractable and never leaves the browser; Kaada gets the public key and a signature proving the key is held.
   */
  const runDevice = useCallback(
    async (operation: Operation) => {
      const show = (next: View) => operation.commit(() => setView(next));
      if (!deviceKeySupported()) {
        show({
          name: "error",
          message: "This browser can't keep a device key. Open the link in Safari or Chrome.",
          retry: "device",
        });
        return;
      }
      show({ name: "creating", action: "device" });
      // Once the registration request has gone out, a failure no longer proves that nothing was created.
      let submitted = false;
      try {
        const key = await generateDeviceKey();
        const optionsResponse = await api("/wallet/device-keys/options", token, {
          method: "POST",
          body: { publicKeyX: key.publicKeyX, publicKeyY: key.publicKeyY },
        });
        if (optionsResponse.status === 401) {
          show({ name: "invalid" });
          return;
        }
        if (!optionsResponse.ok) throw new Error("options");
        const challenge = (await optionsResponse.json()) as {
          keyId: string;
          payload: string;
          challenge: string;
        };
        const { r, s } = await signDevicePayload(key.privateKey, challenge.payload);
        // Kept BEFORE the server records it: a key lost after the server accepted it would lock the wallet.
        await saveDeviceKey(challenge.keyId, key.privateKey);
        submitted = true;
        const registerResponse = await api("/wallet/device-keys/register", token, {
          method: "POST",
          body: {
            publicKeyX: key.publicKeyX,
            publicKeyY: key.publicKeyY,
            challenge: challenge.challenge,
            r,
            s,
          },
        });
        if (registerResponse.status === 401) {
          show({ name: "invalid" });
          return;
        }
        if (registerResponse.status === 502) {
          show({
            name: "error",
            message: SAVED_BUT_UNCONFIRMED,
            retry: "finish",
          });
          return;
        }
        if (!registerResponse.ok) throw new Error("register");
        const body = (await registerResponse.json()) as { wallet: WalletInfo | null };
        if (!body.wallet?.address) throw new Error("no wallet");
        const address = body.wallet.address;
        operation.succeed(() => setView({ name: "done", address }));
      } catch (error) {
        logFailure("setup.device_key_failed", error);
        show(
          submitted
            ? { name: "error", message: describeError(error, DEVICE_UNCONFIRMED), retry: "check" }
            : {
                name: "error",
                message: describeError(error, "Couldn't create a key on this device. Try again."),
                retry: "device",
              },
        );
      }
    },
    [token],
  );

  const createWithDevice = useCallback(async () => {
    const operation = gate.begin();
    if (!operation) return;
    try {
      await runDevice(operation);
    } finally {
      operation.finish();
    }
  }, [gate, runDevice]);

  const create = useCallback(async () => {
    const operation = gate.begin();
    if (!operation) return;
    const show = (next: View) => operation.commit(() => setView(next));
    // Once the verification request has gone out, a failure no longer proves that nothing was created.
    let submitted = false;
    try {
      if (!browserSupportsWebAuthn()) {
        // Passkeys are preferred but not required: without them, a device key is the way in (when it is enabled).
        if (deviceKeysEnabled) {
          await runDevice(operation);
          return;
        }
        show({
          name: "error",
          message: "This browser doesn't support passkeys. Open the link in Safari or Chrome.",
          retry: "create",
        });
        return;
      }
      show({ name: "creating", action: "create" });
      const optionsResponse = await api("/wallet/passkeys/registration/options", token, {
        method: "POST",
      });
      if (optionsResponse.status === 401) {
        show({ name: "invalid" });
        return;
      }
      if (!optionsResponse.ok) throw new Error("options");
      const optionsJSON = (await optionsResponse.json()) as Parameters<
        typeof startRegistration
      >[0]["optionsJSON"];
      const credential = await startRegistration({ optionsJSON });
      submitted = true;
      const verifyResponse = await api("/wallet/passkeys/registration/verify", token, {
        method: "POST",
        body: credential,
      });
      if (verifyResponse.status === 401) {
        show({ name: "invalid" });
        return;
      }
      if (verifyResponse.status === 502) {
        show({ name: "error", message: SAVED_BUT_UNCONFIRMED, retry: "finish" });
        return;
      }
      if (!verifyResponse.ok) throw new Error("verify");
      const body = (await verifyResponse.json()) as { wallet: WalletInfo | null };
      if (!body.wallet?.address) throw new Error("no wallet");
      const address = body.wallet.address;
      operation.succeed(() => setView({ name: "done", address }));
    } catch (error) {
      logFailure("setup.passkey_failed", error);
      const cancelled = error instanceof Error && error.name === "NotAllowedError";
      show(
        cancelled
          ? { name: "error", message: failureCopy.cancelled, retry: "create" }
          : submitted
            ? { name: "error", message: describeError(error, PASSKEY_UNCONFIRMED), retry: "check" }
            : {
                name: "error",
                message: describeError(error, "Couldn't create your passkey. Try again."),
                retry: "create",
              },
      );
    } finally {
      operation.finish();
    }
  }, [deviceKeysEnabled, gate, runDevice, token]);

  return { funded, view, deviceKeysEnabled, finish, createWithDevice, create, reload };
}
