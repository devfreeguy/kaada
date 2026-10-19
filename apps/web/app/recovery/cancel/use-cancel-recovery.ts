"use client";
import { useEffect, useRef, useState } from "react";
import { api, describeError, json } from "../../lib/api";
import { logFailure } from "../../lib/client-log";
import type { RootSigningRequest } from "../../lib/root-material";
import { signRootRequest } from "../../lib/root-material";
import { DeviceKeyMissingError } from "../../lib/root-proof";
type View =
  | { name: "loading" }
  | { name: "missing" }
  | { name: "ready" }
  | { name: "working" }
  | { name: "stopped" }
  | { name: "error"; message: string };
/**
 * "This was not me." The link in the recovery email carries a one-use token in its URL FRAGMENT (which is never sent to a
 * server or a log); it is moved into memory and removed from the address bar at once. A pending recovery can be stopped by
 * exactly one party: the CURRENT root of the wallet (its passkey or device key). Kaada itself cannot stop it, so this page asks
 * the device that controls the wallet to confirm.
 */
export function useCancelRecovery() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: "loading" });
  const captured = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const match = /^#([A-Za-z0-9_-]{20,})$/.exec(window.location.hash);
    if (captured.current === undefined) captured.current = match?.[1] ?? null;
    const fragmentToken = captured.current;
    // Remove the token from the address bar and history straight away.
    window.history.replaceState(null, "", window.location.pathname);
    void Promise.resolve().then(() => {
      if (!fragmentToken) return setView({ name: "missing" });
      setToken(fragmentToken);
      setView({ name: "ready" });
    });
  }, []);
  async function cancelWithRoot() {
    if (!token) return;
    setView({ name: "working" });
    try {
      const request = await json<RootSigningRequest>(
        await api("/recovery/cancel/prepare", token, { method: "POST" }),
      );
      const material = await signRootRequest(request);
      await json(await api("/recovery/cancel", token, { body: { material } }));
      setView({ name: "stopped" });
    } catch (error) {
      logFailure("recovery.cancel_failed", error);
      setView({
        name: "error",
        message:
          error instanceof DeviceKeyMissingError
            ? "This browser doesn't hold your wallet's device key. Open the link on the device or passkey you normally use."
            : describeError(
                error,
                "We couldn’t confirm cancellation. Check the recovery status before trying again.",
              ),
      });
    }
  }
  return { view, cancelWithRoot };
}
