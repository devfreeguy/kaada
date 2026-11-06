import { linkCopy } from "../../lib/app-copy";
import type { LinkSubject } from "../../lib/app-copy";
import { ActionButton } from "./action-button";
import { FlowSection } from "./flow-section";
import { StatusNote } from "./status-note";

/**
 * The three states every link-driven screen has before its real content: loading, an expired link, a load failure. One
 * component, so the payment, setup, wallet-action and security pages say them the same way.
 */
export function FlowStatus({
  kind,
  subject,
  message,
  onRetry,
}: {
  kind: "loading" | "expired" | "load-failed";
  subject: LinkSubject;
  /** For a load failure: why. */
  message?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  if (kind === "loading") {
    return (
      <p role="status" className="text-sm text-app-muted">
        {linkCopy.loading}
      </p>
    );
  }
  if (kind === "expired") {
    const copy = linkCopy.expired(subject);
    return <FlowSection title={copy.title} description={copy.body} />;
  }
  const copy = linkCopy.loadFailed(subject);
  return (
    <FlowSection title={copy.title}>
      {message ? <StatusNote tone="danger">{message}</StatusNote> : null}
      {onRetry ? <ActionButton onClick={onRetry}>{copy.action}</ActionButton> : null}
    </FlowSection>
  );
}
