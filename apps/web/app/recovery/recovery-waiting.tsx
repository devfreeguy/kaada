"use client";
import { FlowSection } from "../components/application/flow-section";
import { RECOVERY_WAITING } from "../lib/recovery-copy";
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
  const step = status.nextStep;
  if (
    step !== "WAIT" &&
    step !== "SUBMITTING" &&
    step !== "FINALIZING" &&
    step !== "WAITING_FOR_PAYMENT"
  ) {
    return null;
  }
  if (step !== "WAIT") {
    const copy = RECOVERY_WAITING[step];
    return <FlowSection title={copy.title} description={copy.description} />;
  }
  const copy = RECOVERY_WAITING.WAIT;
  const deadline = status.executeAfter ? new Date(status.executeAfter).getTime() : null;
  return (
    <FlowSection title={copy.title} description={copy.description}>
      {deadline === null ? (
        <p className="text-sm text-app-muted">{copy.pending}</p>
      ) : deadline <= now ? (
        <p className="text-sm text-app-muted" aria-live="polite">
          {copy.over}
        </p>
      ) : (
        <div>
          <p className="text-sm text-app-muted">{copy.countdown}</p>
          <p className="text-3xl font-semibold" aria-live="polite">
            {remaining(status.executeAfter ?? "", now)}
          </p>
        </div>
      )}
    </FlowSection>
  );
}
