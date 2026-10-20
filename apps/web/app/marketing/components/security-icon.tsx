import { IconKey, IconLockPassword, IconShieldCheck, IconRestore } from "@tabler/icons-react";

export type SecurityFeature = "passkey" | "pin" | "permissions" | "recovery";

const icons = {
  passkey: IconKey,
  pin: IconLockPassword,
  permissions: IconShieldCheck,
  recovery: IconRestore,
};

export function SecurityIcon({
  feature,
  className = "",
}: {
  feature: SecurityFeature;
  className?: string;
}) {
  const Icon = icons[feature];
  return <Icon aria-hidden="true" className={className} stroke={1.7} />;
}
