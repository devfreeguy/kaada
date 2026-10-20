export type SecurityAction = "rotate" | "backup" | "recovery";
export type CredentialAction = "ROTATE_ROOT" | "ENROLL_BACKUP";
export const securityActions = {
  rotate: {
    kind: "ROTATE_ROOT",
    title: "Change your passkey or device",
    intro:
      "Move control to a new passkey or device key. Your current credential confirms the change, and the old one stops working once it is done.",
    done: "Your new credential now controls your wallet. The old one no longer works.",
  },
  backup: {
    kind: "ENROLL_BACKUP",
    title: "Add a backup passkey or device",
    intro:
      "Add another way to access your wallet if you lose this device. Your current credential confirms adding it.",
    done: "Your backup is added. Both credentials can now control your wallet.",
  },
  recovery: {
    title: "Set up recovery",
    intro: "Protect access with your email, authenticator and Recovery Code.",
  },
} as const;
export function parseSecurityAction(value: string | string[] | undefined): SecurityAction | null {
  return value === "rotate" || value === "backup" || value === "recovery" ? value : null;
}
