import { RECOVERY_LOSS_WARNING, RECOVERY_NEEDS, RECOVERY_NEEDS_TITLE } from "../lib/recovery-copy";
/** The two things recovery needs, said plainly, and what happens if both are lost. */
export function RecoveryNeeds() {
  return (
    <div className="rounded-lg bg-white/8 px-4 py-3 text-sm text-white/90">
      <p className="font-medium">{RECOVERY_NEEDS_TITLE}</p>
      <ul className="mt-1 list-disc pl-5">
        {RECOVERY_NEEDS.map((need) => (
          <li key={need}>{need}</li>
        ))}
      </ul>
      <p className="mt-2 font-medium">{RECOVERY_LOSS_WARNING}</p>
    </div>
  );
}
