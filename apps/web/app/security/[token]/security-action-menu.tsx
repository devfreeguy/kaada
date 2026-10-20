"use client";
import { secondaryAction } from "../../components/application/styles";
import { securityActions, type SecurityAction } from "./security-actions";
export function SecurityActionMenu({ onSelect }: { onSelect: (action: SecurityAction) => void }) {
  return (
    <section className="flex flex-col gap-5">
      <h1>Wallet security</h1>
      <p className="text-white/75">Choose what you want to update.</p>
      {(Object.keys(securityActions) as SecurityAction[]).map((action) => (
        <button
          key={action}
          type="button"
          className={`${secondaryAction} text-left`}
          onClick={() => onSelect(action)}
        >
          {securityActions[action].title}
        </button>
      ))}
    </section>
  );
}
