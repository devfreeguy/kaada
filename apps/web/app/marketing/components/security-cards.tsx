import { SecurityCard, type SecurityCardProps } from "./security-card";
import { SecurityStack } from "./security-stack";

const protections: SecurityCardProps[] = [
  {
    feature: "passkey",
    title: "Passkey-secured account",
    description:
      "Your account is protected with a modern root credential designed to stay under your control.",
    color: "var(--lavender)",
  },
  {
    feature: "pin",
    title: "PIN-approved payments",
    description:
      "Kaada can prepare a payment, but you still approve the action before it goes through.",
    color: "var(--orange)",
  },
  {
    feature: "permissions",
    title: "Limited permissions",
    description:
      "Kaada only gets the permissions it needs. It does not receive unrestricted control over your account.",
    color: "var(--emerald)",
  },
  {
    feature: "recovery",
    title: "Protected recovery",
    description:
      "Recovery requires multiple independent checks, including your email, Recovery Code, authenticator, and a waiting period.",
    color: "var(--navy)",
  },
];

export function SecurityCards() {
  return (
    <SecurityStack>
      {protections.map((protection) => (
        <SecurityCard key={protection.feature} {...protection} />
      ))}
    </SecurityStack>
  );
}
