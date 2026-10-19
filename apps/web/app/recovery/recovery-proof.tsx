"use client";
import { primaryAction } from "../components/application/styles";

import type { useRecovery } from "./use-recovery";

export function RecoveryProof({
  busy,
  proveNewCredential,
  status,
}: ReturnType<typeof useRecovery>) {
  const step = status?.nextStep;
  return (
    <>
      {step === "PROVE_NEW_CREDENTIAL" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Recovered. One quick check</h1>
          <p className="text-white/75">
            Confirm that this device can sign for your wallet before you continue.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void proveNewCredential()}
            className={primaryAction}
          >
            Confirm with this device
          </button>
        </section>
      )}
    </>
  );
}
