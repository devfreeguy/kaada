import { IconCheck } from "@tabler/icons-react";
import { SecurityIcon, type SecurityFeature } from "./security-icon";

const details: Record<SecurityFeature, { label: string; title: string; lines: string[] }> = {
  passkey: {
    label: "Your account",
    title: "Secured by you.",
    lines: ["Your passkey", "Your control"],
  },
  pin: {
    label: "Payment approval",
    title: "Your say. Every time.",
    lines: ["Review the details", "Approve on your secure page"],
  },
  permissions: {
    label: "Permission boundaries",
    title: "Only what’s needed.",
    lines: ["Prepare your payment", "Request your approval", "No unrestricted access"],
  },
  recovery: {
    label: "Recovery checks",
    title: "More than one check.",
    lines: ["Email verification", "Recovery Code", "Authenticator", "Waiting period"],
  },
};

export function SecurityIllustration({ feature }: { feature: SecurityFeature }) {
  const detail = details[feature];
  return (
    <div
      className="relative flex min-h-48 items-center justify-center overflow-hidden rounded-[24px] bg-navy/8 p-4 sm:min-h-60 sm:p-6 lg:min-h-80 lg:p-8"
      aria-hidden="true"
    >
      <div className="absolute -top-12 -right-12 size-52 rounded-full border border-current opacity-10" />
      <div className="absolute -bottom-20 -left-12 size-64 rounded-full border border-current opacity-10" />
      <div className="relative w-full max-w-72 rounded-3xl bg-white p-4 text-navy shadow-[0_16px_0_-8px_rgba(5,26,47,0.12)] sm:p-6 lg:p-7">
        <div className="mb-3 flex items-center justify-between gap-3 lg:mb-5">
          <span className="text-[10px] font-bold tracking-[0.14em] uppercase text-navy/60">
            {detail.label}
          </span>
          <SecurityIcon feature={feature} className="size-7 shrink-0 text-navy" />
        </div>
        <p className="font-heading text-2xl leading-tight uppercase lg:text-3xl">{detail.title}</p>
        {feature === "pin" && (
          <div className="my-3 flex gap-2 lg:my-5">
            {Array.from({ length: 6 }, (_, index) => (
              <span key={index} className="size-3 rounded-full bg-lavender" />
            ))}
          </div>
        )}
        <div className="mt-3 grid gap-2 lg:mt-5 lg:gap-3">
          {detail.lines.map((line) => (
            <p key={line} className="flex items-center gap-2.5 text-xs font-medium leading-relaxed">
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald/15">
                <IconCheck aria-hidden="true" size={10} stroke={1.5} />
              </span>
              {line}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
