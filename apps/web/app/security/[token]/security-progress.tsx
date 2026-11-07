"use client";
import { ActionButton } from "../../components/application/action-button";
import { StatusNote } from "../../components/application/status-note";
import type { useSecurity } from "./use-security";
import { changeDoneCopy } from "./security-actions";
export function SecurityProgress({
  progress,
  check,
}: Pick<ReturnType<typeof useSecurity>, "progress" | "check">) {
  switch (progress.name) {
    case "idle":
      return null;
    case "error":
      return <StatusNote tone="danger">{progress.message}</StatusNote>;
    case "working":
      return <StatusNote>{progress.message}</StatusNote>;
    case "pending":
      return (
        <>
          <StatusNote>{progress.message}</StatusNote>
          <ActionButton
            variant="secondary"
            onClick={() => void check(progress.changeId, progress.change)}
          >
            Check status
          </ActionButton>
        </>
      );
    case "done":
      return (
        <StatusNote tone="success">
          {changeDoneCopy(progress.change.kind, progress.change.type)}
        </StatusNote>
      );
  }
}
