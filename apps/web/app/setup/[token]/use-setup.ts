"use client";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeError, json } from "../../lib/api";
import { logFailure } from "../../lib/client-log";
import {
  deviceKeySupported,
  generateDeviceKey,
  saveDeviceKey,
  signDevicePayload,
} from "../../lib/device-key";
interface WalletInfo {
  address: string | null;
  status: string;
}
interface BalanceLine {
  symbol: string;
  formatted: string;
}
type View =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "ready"; deviceKeysEnabled: boolean }
  | { name: "finish" }
  | { name: "creating" }
  | { name: "done"; address: string }
  | { name: "error"; message: string; retry: "load" | "create" | "device" | "finish" };
/** Sends the setup token as a bearer header: it is never put in a body, a query string or a log. */
import { observeRequest } from "../../lib/observe-request";
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
async function loadBalances(token: string): Promise<BalanceLine[]> {
  const body = await json<{ balances: BalanceLine[] }>(await api("/wallet/balances", token));
  return body.balances.filter((line) => line.formatted !== "0");
}
export function useSetup({ token }: { token: string }) {
  const [view, setView] = useState<View>({ name: "loading" });
  const [deviceKeysEnabled, setDeviceKeysEnabled] = useState(false);
  // Securing the account is asked for only once the wallet has received its first funds.
  const [funded, setFunded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [balances, setBalances] = useState<BalanceLine[]>([]);
  const [revision, setRevision] = useState(0);
  const reload = () => {
    setView({ name: "loading" });
    setRevision((value) => value + 1);
  };
  useEffect(
    () =>
      observeRequest(
        () => loadSetup(token),
        (result) => {
          setDeviceKeysEnabled(result.deviceKeysEnabled);
          setFunded(result.funded);
          setView(result.view);
        },
        (error) => {
          logFailure("setup.load_failed", error);
          setView(
            error instanceof ApiError && error.kind === "invalid"
              ? { name: "invalid" }
              : {
                  name: "error",
                  message: describeError(error, "We couldn’t load your wallet. Please try again."),
                  retry: "load",
                },
          );
        },
      ),
    [token, revision],
  );
  const address = view.name === "done" ? view.address : null;
  useEffect(() => {
    if (!address) return;
    return observeRequest(
      () => loadBalances(token),
      setBalances,
      (error) => logFailure("setup.balances_failed", error),
    );
  }, [address, token]);
  const finish = useCallback(async () => {
    setView({ name: "creating" });
    try {
      const response = await api("/wallet/setup/finalize", token, { method: "POST" });
      if (response.status === 401) return setView({ name: "invalid" });
      if (!response.ok) throw new Error("failed");
      const body = (await response.json()) as { wallet: WalletInfo | null };
      if (body.wallet?.address) return setView({ name: "done", address: body.wallet.address });
      throw new Error("no wallet");
    } catch (error) {
      logFailure("setup.finish_failed", error);
      setView({
        name: "error",
        message:
          "Your credential is saved. We couldn’t confirm wallet creation yet. You can retry finishing setup.",
        retry: "finish",
      });
    }
  }, [token]);
  /**
   * The alternative for a browser or phone without passkeys: a P-256 key made by this device. Its private half is
   * non-extractable and never leaves the browser; Kaada gets the public key and a signature proving the key is held.
   */
  const createWithDevice = useCallback(async () => {
    if (!deviceKeySupported()) {
      return setView({
        name: "error",
        message: "This browser can't keep a device key. Please open the link in Safari or Chrome.",
        retry: "device",
      });
    }
    setView({ name: "creating" });
    try {
      const key = await generateDeviceKey();
      const optionsResponse = await api("/wallet/device-keys/options", token, {
        method: "POST",
        body: { publicKeyX: key.publicKeyX, publicKeyY: key.publicKeyY },
      });
      if (optionsResponse.status === 401) return setView({ name: "invalid" });
      if (!optionsResponse.ok) throw new Error("options");
      const challenge = (await optionsResponse.json()) as {
        keyId: string;
        payload: string;
        challenge: string;
      };
      const { r, s } = await signDevicePayload(key.privateKey, challenge.payload);
      // Kept BEFORE the server records it: a key lost after the server accepted it would lock the wallet.
      await saveDeviceKey(challenge.keyId, key.privateKey);
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
      if (registerResponse.status === 401) return setView({ name: "invalid" });
      if (registerResponse.status === 502) {
        return setView({
          name: "error",
          message:
            "Your device key is saved, but the wallet could not be created yet. Please try again.",
          retry: "finish",
        });
      }
      if (!registerResponse.ok) throw new Error("register");
      const body = (await registerResponse.json()) as { wallet: WalletInfo | null };
      if (!body.wallet?.address) throw new Error("no wallet");
      setView({ name: "done", address: body.wallet.address });
    } catch (error) {
      logFailure("setup.device_key_failed", error);
      setView({
        name: "error",
        message: describeError(
          error,
          "We couldn’t confirm setup. Reload your wallet before trying again.",
        ),
        retry: "load",
      });
    }
  }, [token]);
  const create = useCallback(async () => {
    if (!browserSupportsWebAuthn()) {
      // Passkeys are preferred but not required: without them, a device key is the way in (when it is enabled).
      if (deviceKeysEnabled) return createWithDevice();
      return setView({
        name: "error",
        message: "This browser doesn't support passkeys. Please open the link in Safari or Chrome.",
        retry: "create",
      });
    }
    setView({ name: "creating" });
    try {
      const optionsResponse = await api("/wallet/passkeys/registration/options", token, {
        method: "POST",
      });
      if (optionsResponse.status === 401) return setView({ name: "invalid" });
      if (!optionsResponse.ok) throw new Error("options");
      const optionsJSON = (await optionsResponse.json()) as Parameters<
        typeof startRegistration
      >[0]["optionsJSON"];
      const credential = await startRegistration({ optionsJSON });
      const verifyResponse = await api("/wallet/passkeys/registration/verify", token, {
        method: "POST",
        body: credential,
      });
      if (verifyResponse.status === 401) return setView({ name: "invalid" });
      if (verifyResponse.status === 502) {
        return setView({
          name: "error",
          message:
            "Your credential is saved. We couldn’t confirm wallet creation yet. You can retry finishing setup.",
          retry: "finish",
        });
      }
      if (!verifyResponse.ok) throw new Error("verify");
      const body = (await verifyResponse.json()) as { wallet: WalletInfo | null };
      if (!body.wallet?.address) throw new Error("no wallet");
      setView({ name: "done", address: body.wallet.address });
    } catch (error) {
      logFailure("setup.passkey_failed", error);
      const cancelled = error instanceof Error && error.name === "NotAllowedError";
      setView({
        name: "error",
        message: cancelled
          ? "Passkey creation was cancelled. You can try again when you're ready."
          : describeError(
              error,
              "We couldn’t confirm setup. Reload your wallet before trying again.",
            ),
        retry: cancelled ? "create" : "load",
      });
    }
  }, [token, deviceKeysEnabled, createWithDevice]);
  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      logFailure("setup.clipboard_failed", error);
      // Clipboard access can be refused; the address is still on screen.
    }
  }, []);
  return {
    funded,
    view,
    deviceKeysEnabled,
    copied,
    balances,
    finish,
    createWithDevice,
    create,
    copy,
    reload,
  };
}
