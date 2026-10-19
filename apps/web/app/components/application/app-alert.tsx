import type { ReactNode } from "react";
export function AppAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-2xl border border-coral/40 bg-coral/15 px-4 py-3 text-sm text-white"
    >
      {children}
    </p>
  );
}
