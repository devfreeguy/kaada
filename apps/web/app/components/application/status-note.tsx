import type { ReactNode } from "react";

/** A short message about what just happened. Tone carries the meaning; colour is never the only signal. */
type Tone = "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  info: "border-app-border bg-app-surface-2 text-app-muted",
  success: "border-app-success/30 bg-app-success/10 text-app-text",
  warning: "border-app-warning/30 bg-app-warning/10 text-app-text",
  danger: "border-app-danger/30 bg-app-danger/10 text-app-text",
};

export function StatusNote({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  const urgent = tone === "danger" || tone === "warning";
  return (
    <p
      role={urgent ? "alert" : "status"}
      className={`rounded-xl border px-4 py-3 text-sm ${TONES[tone]}`}
    >
      {children}
    </p>
  );
}
