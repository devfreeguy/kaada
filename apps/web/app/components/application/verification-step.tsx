import type { ReactNode } from "react";
import { verifyCopy } from "../../lib/app-copy";
import type { VerifyContext, VerifyMethod } from "../../lib/app-copy";
import { ActionButton } from "./action-button";
import { FlowSection } from "./flow-section";
import { StatusNote } from "./status-note";

/**
 * The one screen for proving it is you, whatever you are proving it FOR. The words come from the context and the method
 * (see app-copy.ts), so a payment, a wallet setup and a one-time wallet action each read as what they are, from the same
 * component.
 *
 * Pass `children` (for example the PIN keypad) to replace the button when the proof is typed rather than tapped.
 */
export function VerificationStep({
  context,
  method,
  hint,
  waiting = false,
  notice,
  summary,
  onConfirm,
  actionHidden = false,
  alternative,
  footer,
  children,
}: {
  context: VerifyContext;
  method: VerifyMethod;
  /** The line under the title, when this screen knows better than the default for its context. */
  hint?: string;
  /** The prompt or request is open. */
  waiting?: boolean;
  /** Why the last attempt did not go through. */
  notice?: string | null | undefined;
  /** What is being verified, shown above the action (a payment summary). */
  summary?: ReactNode;
  onConfirm?: () => void;
  /** Withhold the action (for example while a PIN lock runs). */
  actionHidden?: boolean;
  /** A quieter second way to do the same thing. */
  alternative?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const copy = verifyCopy(context, method);
  return (
    <FlowSection title={copy.title} description={hint ?? copy.hint}>
      {summary}
      {notice ? <StatusNote tone="danger">{notice}</StatusNote> : null}
      {actionHidden
        ? null
        : (children ?? (
            <ActionButton busy={waiting} busyLabel={copy.waiting} onClick={onConfirm}>
              {copy.action}
            </ActionButton>
          ))}
      {alternative}
      {footer}
    </FlowSection>
  );
}
