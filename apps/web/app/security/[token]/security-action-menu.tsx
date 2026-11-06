"use client";
import { ActionButton } from "../../components/application/action-button";
import { FlowSection } from "../../components/application/flow-section";
import { securityActions, type SecurityAction } from "./security-actions";
export function SecurityActionMenu({ onSelect }: { onSelect: (action: SecurityAction) => void }) {
  return (
    <FlowSection title="Wallet security" description="Choose what to update.">
      {(Object.keys(securityActions) as SecurityAction[]).map((action) => (
        <ActionButton
          key={action}
          variant="secondary"
          className="justify-start text-left"
          onClick={() => onSelect(action)}
        >
          {securityActions[action].title}
        </ActionButton>
      ))}
    </FlowSection>
  );
}
