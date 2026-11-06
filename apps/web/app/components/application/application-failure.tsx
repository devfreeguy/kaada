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
    <FlowSection
      title="Something went wrong"
      description="If you approved something, check your chat before trying again."
    >
      {reference && <p className="text-xs break-all text-app-faint">Reference: {reference}</p>}
      <ActionButton onClick={reset}>Reload</ActionButton>
    </FlowSection>
  );
}
