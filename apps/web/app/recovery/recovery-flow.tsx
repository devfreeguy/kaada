"use client";

import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { PinKeypad } from "../components/pin-keypad";
import { RecoveryCodeCreator } from "../components/recovery-code-creator";
import { api, describeError, json } from "../lib/api";
import { deviceKeySupported } from "../lib/device-key";
import { RECOVERY_LOSS_WARNING, RECOVERY_NEEDS, RECOVERY_NEEDS_TITLE } from "../lib/recovery-copy";
import { deviceKeyIdFromPoint } from "../lib/device-key-id";
import { newDeviceKey, registerPasskey } from "../lib/new-root";
import { deriveRecoveryKey, parseRecoveryCode, signRecovery } from "../lib/recovery-code";
import type { ServerTypedData } from "../lib/recovery-code";
import { signRootRequest } from "../lib/root-material";
import type { RootSigningRequest } from "../lib/root-material";
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
  } catch {
    return null;
  }
}

function saveSession(value: { token: string; proposal?: Proposal } | null): void {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be refused (private mode); the flow still works until the page is reloaded.
  }
}

const button =
  "rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white disabled:opacity-50";
const secondary = "rounded-xl border border-neutral-300 px-5 py-4 text-base font-medium";

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
      {children}
    </p>
  );
}

function remaining(until: string, now: number): string {
  const ms = Math.max(0, new Date(until).getTime() - now);
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days > 0 ? `${String(days)}d` : "", `${String(hours)}h`, `${String(minutes)}m`]
    .filter(Boolean)
    .join(" ");
}

/**
 * Account recovery, start to finish. The server decides every step (`nextStep`); this page only shows the matching one.
 * Secrets stay on this device: the Recovery Code is typed here and signs locally, a new device key never leaves the browser,
 * and the session token is kept for this tab only.
 */
export function RecoveryFlow() {
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
      saveSession(null);
      setSession(null);
      setStatus(null);
      setError(describeError(failure, "This recovery session is no longer available."));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const stored = loadSession();
      if (stored) {
        setSession(stored);
        await refresh(stored.token);
      }
      setReady(true);
    })();
  }, [refresh]);

  // While waiting, keep the countdown moving and the status fresh; finalize as soon as the delay has passed.
  const waiting =
    status?.nextStep === "WAIT" ||
    status?.nextStep === "SUBMITTING" ||
    status?.nextStep === "FINALIZING" ||
    status?.nextStep === "WAITING_FOR_PAYMENT";
  useEffect(() => {
    if (!waiting || !token) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      void (async () => {
        try {
          const due = status?.executeAfter && new Date(status.executeAfter).getTime() <= Date.now();
          if (due) await api("/recovery/finalize", token, { method: "POST" });
        } catch {
          // The next poll tries again; finalization is idempotent on the server.
        }
        await refresh(token);
      })();
    }, 10_000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [waiting, token, status?.executeAfter, refresh]);

  const run = useCallback(async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
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

  if (!ready) return <p className="text-neutral-600">Loading...</p>;

  const step = status?.nextStep;
  return (
    <div className="flex flex-col gap-5">
      {error && <Alert>{error}</Alert>}

      {!session && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Recover your wallet</h1>
          <p className="text-neutral-600">
            Lost your device or passkey? Enter the email linked to your Kaada account. You will need
            your Recovery Code and your authenticator app. For your safety, a recovery takes a few
            days and you are told by email when it starts.
          </p>
          <div className="rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800">
            <p className="font-medium">{RECOVERY_NEEDS_TITLE}</p>
            <ul className="mt-1 list-disc pl-5">
              {RECOVERY_NEEDS.map((need) => (
                <li key={need}>{need}</li>
              ))}
            </ul>
            <p className="mt-2 font-medium">{RECOVERY_LOSS_WARNING}</p>
          </div>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            aria-label="Email address"
            className="rounded-lg border border-neutral-300 px-4 py-3"
          />
          <button
            type="button"
            disabled={busy || email.length < 5}
            onClick={() => void start()}
            className={button}
          >
            {busy ? "Starting..." : "Start recovery"}
          </button>
        </section>
      )}

      {session && !status && !error && <p className="text-neutral-600">Loading...</p>}

      {step === "VERIFY_EMAIL" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Check your email</h1>
          <p className="text-neutral-600">
            If that address belongs to a Kaada wallet, we sent a 6-digit code. It expires soon.
          </p>
          <input
            value={emailCode}
            onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Email code"
            className="rounded-lg border border-neutral-300 px-4 py-3 text-center font-mono text-xl tracking-widest"
          />
          <button
            type="button"
            disabled={busy || emailCode.length < 6}
            onClick={() => void verifyEmail()}
            className={button}
          >
            Verify
          </button>
          <button type="button" disabled={busy} onClick={() => void resend()} className={secondary}>
            Send a new code
          </button>
        </section>
      )}

      {step === "CREATE_CREDENTIAL" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Set up this device</h1>
          <p className="text-neutral-600">
            Choose how this device will protect your wallet from now on.
          </p>
          {browserSupportsWebAuthn() && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void createPasskey()}
              className={button}
            >
              {busy ? "Waiting for your device..." : "Create a new passkey"}
            </button>
          )}
          {deviceKeySupported() && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void createDeviceKey()}
              className={secondary}
            >
              No passkey? Use a key kept by this device
            </button>
          )}
        </section>
      )}

      {step === "PROVE_RECOVERY_FACTORS" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Prove it is you</h1>
          {!session?.proposal ? (
            <>
              <p className="text-neutral-600">
                This page lost its progress (it was reloaded). Start again to continue.
              </p>
              <button type="button" onClick={forget} className={button}>
                Start again
              </button>
            </>
          ) : (
            <>
              <p className="text-neutral-600">
                Your Recovery Code is checked on this device and never sent to Kaada. It authorises
                this one recovery. Then enter the 6-digit code from your authenticator app.
              </p>
              <input
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-label="Recovery Code"
                className="rounded-lg border border-neutral-300 px-4 py-3 font-mono"
              />
              <input
                value={authenticatorCode}
                onChange={(event) =>
                  setAuthenticatorCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="6-digit code from your authenticator app"
                placeholder="000000"
                className="rounded-lg border border-neutral-300 px-4 py-3 font-mono tracking-widest"
              />
              <button
                type="button"
                disabled={busy || recoveryCode.length < 20 || authenticatorCode.length !== 6}
                onClick={() => void proveWithCode()}
                className={button}
              >
                {busy ? "Checking..." : "Start the recovery"}
              </button>
            </>
          )}
        </section>
      )}

      {waiting && status && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Recovery in progress</h1>
          {status.executeAfter ? (
            <>
              <p className="text-neutral-600">Your wallet will move to this device in about</p>
              <p className="text-3xl font-semibold" aria-live="polite">
                {remaining(status.executeAfter, now)}
              </p>
            </>
          ) : (
            <p className="text-neutral-600">Working on it...</p>
          )}
          <p className="text-sm text-neutral-600">
            This delay protects you: if anyone else started this, the owner of the current device
            can cancel it. We emailed you a link that stops it. You can leave this page; come back
            to it on this device.
          </p>
        </section>
      )}

      {step === "PROVE_NEW_CREDENTIAL" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Recovered. One quick check</h1>
          <p className="text-neutral-600">
            Confirm that this device can sign for your wallet before you continue.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void proveNewCredential()}
            className={button}
          >
            Confirm with this device
          </button>
        </section>
      )}

      {step === "RESET_PIN" && token && (
        <PinReset token={token} onDone={() => void refresh(token)} />
      )}

      {step === "CREATE_RECOVERY_CODE" && token && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Last step: set up recovery again</h1>
          <p className="text-neutral-600">
            Your old Recovery Code and authenticator app were used up by this recovery. Link a new
            authenticator app and create a new Recovery Code to protect your wallet again.
          </p>
          <RecoveryCodeCreator token={token} onDone={() => void refresh(token)} />
        </section>
      )}

      {step === "DONE" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">Your wallet is recovered</h1>
          <p className="text-neutral-600">
            This device now controls your wallet. Your new PIN, authenticator app and Recovery Code
            are set.
          </p>
          <button type="button" onClick={forget} className={secondary}>
            Close
          </button>
        </section>
      )}

      {step === "STOPPED" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This recovery was stopped</h1>
          <p className="text-neutral-600">
            It was cancelled from the device or passkey that controls your wallet. Nothing changed.
            You can start again.
          </p>
          <button type="button" onClick={forget} className={button}>
            Start again
          </button>
        </section>
      )}

      {step === "FAILED" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">This recovery couldn&apos;t continue</h1>
          <p className="text-neutral-600">
            {status?.blockedReason
              ? "It can't start right now. Try again later."
              : "Something went wrong. Nothing was changed. You can start again."}
          </p>
          <button type="button" onClick={forget} className={button}>
            Start again
          </button>
        </section>
      )}
    </div>
  );
}

/** The new 6-digit PIN after a recovery (the recovery session is the proof; no root is needed). */
function PinReset({ token, onDone }: { token: string; onDone: () => void }) {
  const [first, setFirst] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit() {
    if (first === null) {
      setFirst(value);
      setValue("");
      return;
    }
    const entered = value;
    setValue("");
    if (entered !== first) {
      setFirst(null);
      setMessage("The two PINs didn't match. Start again.");
      return;
    }
    setWorking(true);
    try {
      await json(await api("/recovery/pin", token, { body: { pin: entered } }));
      onDone();
    } catch (failure) {
      setFirst(null);
      setMessage(describeError(failure, "We couldn't save your PIN. Please try again."));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">
        {first === null ? "Set a new 6-digit PIN" : "Enter it again"}
      </h1>
      <p className="text-neutral-600">
        You will use this PIN to approve each payment. Your old PIN no longer works.
      </p>
      {message && <Alert>{message}</Alert>}
      <PinKeypad
        value={value}
        onChange={setValue}
        onSubmit={() => void submit()}
        disabled={working}
        submitLabel={first === null ? "Next" : "Save"}
      />
    </section>
  );
}
