"use client";
import { useState } from "react";
import { api, describeError, json } from "../lib/api";
import { logFailure } from "../lib/client-log";
/** The new 6-digit PIN after a recovery (the recovery session is the proof; no root is needed). */
export function usePinReset({ token, onDone }: { token: string; onDone: () => void }) {
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
      logFailure("recovery.pin_failed", failure);
      setFirst(null);
      setMessage(describeError(failure, "We couldn't save your PIN. Please try again."));
    } finally {
      setWorking(false);
    }
  }
  return { first, value, setValue, message, working, submit };
}
