import type { ReactNode } from "react";
import { SecurityCard, type SecurityCardProps } from "./security-card";
import { SecurityStack } from "./security-stack";

const protections: SecurityCardProps[] = [
  {
    feature: "passkey",
    title: "Your account, your key",
    description: "Your passkey or device key protects your account. Kaada cannot use it for you.",
    color: "var(--lavender)",
  },
  {
    feature: "pin",
    title: "Your PIN, your approval",
    description:
      "Check the details, then enter your payment PIN on the secure Kaada page to approve.",
    color: "var(--orange)",
  },
  {
    feature: "permissions",
    title: "You set the limits",
    description:
      "Kaada can only send the payment you approve, to the person and for the amount you agreed to.",
    color: "var(--emerald)",
  },
  {
    feature: "recovery",
    title: "A way back in",
    description:
      "Set up recovery before you need it. Getting back in takes your email, Recovery Code, a code from your authenticator app and a waiting period.",
    color: "var(--navy)",
  },
];

export function SecurityCards({ heading }: { heading: ReactNode }) {
  return (
    <SecurityStack heading={heading}>
      {protections.map((protection) => (
        <SecurityCard key={protection.feature} {...protection} />
      ))}
    </SecurityStack>
  );
}
