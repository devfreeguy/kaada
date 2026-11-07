export type SecurityAction = "rotate" | "backup" | "recovery";
export type CredentialAction = "ROTATE_ROOT" | "ENROLL_BACKUP";
export const securityActions = {
  rotate: {
    kind: "ROTATE_ROOT",
    title: "Change passkey or device",
    intro: "Your current passkey or device confirms the change. The old one stops working.",
  },
  backup: {
    kind: "ENROLL_BACKUP",
    title: "Add a backup",
    intro: "A second way in if you lose this device. Your current passkey or device confirms it.",
  },
  recovery: {
    title: "Set up recovery",
  },
} as const;

/** What a finished change says, from WHICH change it was: the same words whether it finished at once or after "Check status". */
export function changeDoneCopy(kind: CredentialAction, type: "PASSKEY" | "DEVICE_KEY"): string {
  if (kind === "ENROLL_BACKUP") return "Backup added. You can use either method.";
  return type === "PASSKEY"
    ? "Your new passkey is ready. The old one no longer works."
    : "Your device key is ready. The old one no longer works.";
}

export function parseSecurityAction(value: string | string[] | undefined): SecurityAction | null {
  return value === "rotate" || value === "backup" || value === "recovery" ? value : null;
}
