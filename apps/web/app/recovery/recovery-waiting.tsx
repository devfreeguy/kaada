"use client";
import { FlowSection } from "../components/application/flow-section";
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
  if (!waiting || !status) return null;
  return (
    <FlowSection
      title="Recovery in progress"
      description="This delay protects you. The owner of the current device can cancel it from the email link we sent. You can leave and come back on this device."
    >
      {status.executeAfter ? (
        <div>
          <p className="text-sm text-app-muted">Your wallet moves to this device in about</p>
          <p className="text-3xl font-semibold" aria-live="polite">
            {remaining(status.executeAfter, now)}
          </p>
        </div>
      ) : (
        <p className="text-sm text-app-muted">Working…</p>
      )}
    </FlowSection>
  );
}
