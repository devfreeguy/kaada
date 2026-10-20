"use client";
import { secondaryAction } from "../../components/application/styles";
import type { useSecurity } from "./use-security";
import { securityActions } from "./security-actions";
export function SecurityProgress({
  progress,
  check,
}: Pick<ReturnType<typeof useSecurity>, "progress" | "check">) {
  if (progress.name === "idle") return null;
  if (progress.name === "error")
    return (
      <p role="alert" className="rounded-lg bg-coral/15 px-4 py-3 text-sm text-white">
        {progress.message}
      </p>
    );
  if (progress.name === "working")
    return (
      <p role="status" className="text-white/75">
        {progress.message}
      </p>
    );
  if (progress.name === "pending")
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-white/75">
          {progress.message}
        </p>
        <button
          type="button"
          className={secondaryAction}
          onClick={() => void check(progress.changeId)}
        >
          Check change status
        </button>
      </div>
    );
  return (
    <p role="status" className="rounded-2xl bg-emerald/15 p-4 text-white">
      {progress.name === "done"
        ? securityActions[progress.kind === "ROTATE_ROOT" ? "rotate" : "backup"].done
        : "Your security change is confirmed."}
    </p>
  );
}
