import { errorCopy } from "../../lib/app-copy";
import { ActionButton } from "./action-button";
import { FlowSection } from "./flow-section";

export function ApplicationFailure({
  reference,
  reset,
}: {
  reference?: string | undefined;
  reset: () => void;
}) {
  return (
    <FlowSection title={errorCopy.title} description={errorCopy.body}>
      {reference && <p className="text-xs break-all text-app-faint">Reference: {reference}</p>}
      <ActionButton onClick={reset}>{errorCopy.action}</ActionButton>
    </FlowSection>
  );
}
