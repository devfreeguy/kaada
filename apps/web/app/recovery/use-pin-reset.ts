"use client";
import { useState } from "react";
import { api, describeError, json } from "../lib/api";
import { logFailure } from "../lib/client-log";
import { useOperation } from "../lib/use-operation";
import { useWhen } from "../lib/use-when";
/** The new 6-digit PIN after a recovery (the recovery session is the proof; no root is needed). */
export function usePinReset({ token, onDone }: { token: string; onDone: () => void }) {
  const [first, setFirst] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [saved, setSaved] = useState(false);
  const gate = useOperation();
  // The parent is told once the PIN IS saved, from here and not from inside the save: if it fails it cannot turn a saved PIN into an error.
  useWhen(saved, onDone);
  async function submit() {
    // A new entry starts clean: the last attempt's notice does not follow it.
    setMessage(null);
    if (first === null) {
      setFirst(value);
      setValue("");
      return;
    }
    const entered = value;
    setValue("");
    if (entered !== first) {
      setFirst(null);
      setMessage("The PINs didn’t match. Start again.");
      return;
    }
    const operation = gate.begin();
    if (!operation) return;
    operation.commit(() => setWorking(true));
    try {
      await json(await api("/recovery/pin", token, { body: { pin: entered } }));
      operation.succeed(() => {
        setWorking(false);
        setSaved(true);
      });
    } catch (failure) {
      logFailure("recovery.pin_failed", failure);
      operation.commit(() => {
        setFirst(null);
        setWorking(false);
        setMessage(describeError(failure, "Couldn’t save your PIN. Try again."));
      });
    } finally {
      operation.finish();
    }
  }
  return { first, value, setValue, message, working, submit };
}
