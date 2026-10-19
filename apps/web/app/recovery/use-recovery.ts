"use client";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { api, ApiError, describeError, json } from "../lib/api";
import { logFailure } from "../lib/client-log";
import { deviceKeyIdFromPoint } from "../lib/device-key-id";
import { newDeviceKey, registerPasskey } from "../lib/new-root";
import type { ServerTypedData } from "../lib/recovery-code";
import { deriveRecoveryKey, parseRecoveryCode, signRecovery } from "../lib/recovery-code";
import type { RootSigningRequest } from "../lib/root-material";
import { signRootRequest } from "../lib/root-material";
import { DeviceKeyMissingError } from "../lib/root-proof";
type NextStep =
  | "VERIFY_EMAIL"
  | "CREATE_CREDENTIAL"
  | "PROVE_RECOVERY_FACTORS"
  | "SUBMITTING"
  | "WAIT"
  | "WAITING_FOR_PAYMENT"
  | "FINALIZING"
  | "PROVE_NEW_CREDENTIAL"
  | "RESET_PIN"
  | "CREATE_RECOVERY_CODE"
  | "DONE"
  | "STOPPED"
  | "FAILED";
interface Status {
  status: string;
  nextStep: NextStep;
  chainId: number;
  account?: Address;
  recoveryAddress?: string;
  newRootKind?: "PASSKEY" | "DEVICE_KEY";
  executeAfter?: string;
  blockedReason?: string;
}
interface Proposal {
  typedData: ServerTypedData;
  chainId: number;
  account: Address;
  recoveryAddress: string;
}
const STORAGE_KEY = "kaada.recovery.session";
/** The session token lives in this tab's sessionStorage only: never in the URL, a cookie or a log. */
function loadSession(): { token: string; proposal?: Proposal } | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { token: string; proposal?: Proposal }) : null;
  } catch (error) {
    logFailure("recovery.session_restore_failed", error);
    return null;
  }
}
function saveSession(value: { token: string; proposal?: Proposal } | null): void {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    logFailure("recovery.session_save_failed", error);
    // Storage can be refused (private mode); the flow still works until the page is reloaded.
  }
}
/**
 * Account recovery, start to finish. The server decides every step (`nextStep`); this page only shows the matching one.
 * Secrets stay on this device: the Recovery Code is typed here and signs locally, a new device key never leaves the browser,
 * and the session token is kept for this tab only.
 */
import { useBrowserCapabilities } from "../lib/browser-capabilities";
import { watchRecovery } from "./recovery-polling";
function restoreSession(
  restore: (value: { token: string; proposal?: Proposal }) => void,
  refresh: (token: string) => Promise<void>,
  ready: () => void,
) {
  let active = true;
  const stored = loadSession();
  void Promise.resolve().then(async () => {
    if (!active) return;
    if (stored) {
      restore(stored);
      await refresh(stored.token);
    }
    if (active) ready();
  });
  return () => {
    active = false;
  };
}
export function useRecovery() {
  const capabilities = useBrowserCapabilities();
  const [session, setSession] = useState<{ token: string; proposal?: Proposal } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [authenticatorCode, setAuthenticatorCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const token = session?.token ?? null;
  const refresh = useCallback(async (value: string) => {
    try {
      setStatus(await json<Status>(await api("/recovery/status", value)));
      setError(null);
    } catch (failure) {
      logFailure("recovery.status_failed", failure);
      if (failure instanceof ApiError && failure.kind === "invalid") {
        saveSession(null);
        setSession(null);
        setStatus(null);
      }
      setError(
        describeError(failure, "We couldn’t refresh recovery. Your progress is kept; try again."),
      );
    }
  }, []);
  useEffect(() => restoreSession(setSession, refresh, () => setReady(true)), [refresh]);
  // While waiting, keep the countdown moving and the status fresh; finalize as soon as the delay has passed.
  const waiting =
    status?.nextStep === "WAIT" ||
    status?.nextStep === "SUBMITTING" ||
    status?.nextStep === "FINALIZING" ||
    status?.nextStep === "WAITING_FOR_PAYMENT";
  useEffect(
    () =>
      waiting && token ? watchRecovery(token, status?.executeAfter, refresh, setNow) : undefined,
    [waiting, token, status?.executeAfter, refresh],
  );
  const run = useCallback(async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      logFailure("recovery.step_failed", failure);
      setError(
        failure instanceof DeviceKeyMissingError
          ? "This browser doesn't hold your wallet's device key."
          : describeError(failure, fallback),
      );
    } finally {
      setBusy(false);
    }
  }, []);
  const start = () =>
    run(async () => {
      const started = await json<{ token: string }>(
        await api("/recovery/start", null, { body: { email } }),
      );
      const next = { token: started.token };
      saveSession(next);
      setSession(next);
      await refresh(started.token);
    }, "We couldn't start recovery. Check the email address and try again.");
  const verifyEmail = () =>
    run(async () => {
      if (!token) return;
      await json(await api("/recovery/verify-email", token, { body: { code: emailCode } }));
      setEmailCode("");
      await refresh(token);
    }, "That code didn't work. Check it and try again.");
  const resend = () =>
    run(async () => {
      if (!token) return;
      await json(await api("/recovery/resend", token, { method: "POST" }));
    }, "We couldn't send a new code yet. Please wait a moment.");
  const keep = (proposal: Proposal) => {
    const next = { token: token ?? "", proposal };
    saveSession(next);
    setSession(next);
  };
  const createPasskey = () =>
    run(async () => {
      if (!token) return;
      const options = await json<{
        challenge: string;
        rpId: string;
        userId: string;
        userName: string;
      }>(await api("/recovery/passkey/options", token, { method: "POST" }));
      const response = await registerPasskey(options);
      keep(
        await json<Proposal>(await api("/recovery/root/passkey", token, { body: { response } })),
      );
      await refresh(token);
    }, "We couldn't create your new passkey.");
  const createDeviceKey = () =>
    run(async () => {
      if (!token) return;
      const key = await newDeviceKey();
      // Filed under the id the server will derive BEFORE the server records it: a key lost afterwards would lock the wallet.
      await key.keep(deviceKeyIdFromPoint(key.publicKeyX, key.publicKeyY));
      keep(
        await json<Proposal>(
          await api("/recovery/root/device-key", token, {
            body: { publicKeyX: key.publicKeyX, publicKeyY: key.publicKeyY },
          }),
        ),
      );
      await refresh(token);
    }, "We couldn't create a key on this device.");
  const proveWithCode = () =>
    run(async () => {
      if (!token || !status?.account || !session?.proposal) {
        throw new Error("no proposal");
      }
      const canonical = parseRecoveryCode(recoveryCode);
      if (!canonical) throw new Error("malformed");
      if (!/^[0-9]{6}$/.test(authenticatorCode)) throw new Error("malformed code");
      const derived = deriveRecoveryKey(canonical, {
        chainId: status.chainId,
        account: status.account,
      });
      if (
        status.recoveryAddress &&
        derived.address.toLowerCase() !== status.recoveryAddress.toLowerCase()
      ) {
        throw Object.assign(new Error("wrong code"), { name: "WrongCode" });
      }
      const signature = await signRecovery(
        canonical,
        { chainId: status.chainId, account: status.account },
        session.proposal.typedData,
      );
      setRecoveryCode("");
      const code = authenticatorCode;
      setAuthenticatorCode("");
      await json(
        await api("/recovery/proof", token, { body: { signature, authenticatorCode: code } }),
      );
      await refresh(token);
    }, "That didn't work. Check your Recovery Code and the code in your authenticator app, then try again.");
  const proveNewCredential = () =>
    run(async () => {
      if (!token) return;
      const request = await json<RootSigningRequest>(
        await api("/recovery/signing-proof/options", token, { method: "POST" }),
      );
      const material = await signRootRequest(request);
      await json(await api("/recovery/signing-proof", token, { body: { material } }));
      await refresh(token);
    }, "We couldn't confirm your new credential.");
  const forget = () => {
    saveSession(null);
    setSession(null);
    setStatus(null);
    setError(null);
  };
  return {
    session,
    status,
    ready,
    busy,
    error,
    email,
    setEmail,
    emailCode,
    setEmailCode,
    recoveryCode,
    setRecoveryCode,
    authenticatorCode,
    setAuthenticatorCode,
    now,
    token,
    waiting,
    refresh,
    start,
    verifyEmail,
    resend,
    createPasskey,
    createDeviceKey,
    proveWithCode,
    proveNewCredential,
    forget,
    capabilities,
  };
}
