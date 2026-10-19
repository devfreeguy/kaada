"use client";

import type { useRecovery } from "./use-recovery";
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

export function RecoveryWaiting({ status, now, waiting }: ReturnType<typeof useRecovery>) {
  return (
    <>
      {waiting && status && (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Recovery in progress</h1>
          {status.executeAfter ? (
            <>
              <p className="text-white/75">Your wallet will move to this device in about</p>
              <p className="text-3xl font-semibold" aria-live="polite">
                {remaining(status.executeAfter, now)}
              </p>
            </>
          ) : (
            <p className="text-white/75">Working on it...</p>
          )}
          <p className="text-sm text-white/75">
            This delay protects you: if anyone else started this, the owner of the current device
            can cancel it. We emailed you a link that stops it. You can leave this page; come back
            to it on this device.
          </p>
        </section>
      )}
    </>
  );
}
