export type SecurityAction = "rotate" | "backup" | "recovery";
export type CredentialAction = "ROTATE_ROOT" | "ENROLL_BACKUP";
export const securityActions = {
  rotate: {
    kind: "ROTATE_ROOT",
    title: "Change passkey or device",
    intro: "Your current passkey or device confirms the change. The old one stops working.",
    done: "Done. Your new credential controls your wallet and the old one no longer works.",
  },
  backup: {
    kind: "ENROLL_BACKUP",
    title: "Add a backup",
    intro: "A second way in if you lose this device. Your current credential confirms it.",
    done: "Backup added. Either credential now controls your wallet.",
  },
  recovery: {
    title: "Set up recovery",
  },
} as const;
export function parseSecurityAction(value: string | string[] | undefined): SecurityAction | null {
  return value === "rotate" || value === "backup" || value === "recovery" ? value : null;
}
