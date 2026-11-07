import { RECOVERY_LOSS_WARNING, RECOVERY_NEEDS, RECOVERY_NEEDS_TITLE } from "../lib/recovery-copy";

/**
 * The things recovery needs, and what happens if they are lost. The wording is shared with the docs (recovery-copy.ts).
 * `only="warning"` is the loss warning on its own, for the step where the Recovery Code is created: the list has already been
 * shown by then, the warning is what matters there.
 */
export function RecoveryNeeds({ only }: { only?: "warning" }) {
  if (only === "warning") {
    return (
      <p className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-sm font-medium">
        {RECOVERY_LOSS_WARNING}
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-sm">
      <p className="font-medium">{RECOVERY_NEEDS_TITLE}</p>
      <ul className="mt-1 list-disc pl-5 text-app-muted">
        {RECOVERY_NEEDS.map((need) => (
          <li key={need}>{need}</li>
        ))}
      </ul>
      <p className="mt-2 font-medium">{RECOVERY_LOSS_WARNING}</p>
    </div>
  );
}
