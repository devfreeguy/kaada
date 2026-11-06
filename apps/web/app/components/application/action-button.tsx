import type { ComponentPropsWithoutRef } from "react";

/** The application's actions. One main action per screen is `primary`; everything else is quieter. */
type Variant = "primary" | "secondary" | "quiet";

const BASE =
  "inline-flex min-h-12 items-center justify-center rounded-xl px-5 text-[15px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-app-primary text-app-on-primary hover:bg-app-primary-hover",
  secondary: "border border-app-border-strong text-app-text hover:bg-app-surface-2",
  quiet: "text-app-muted hover:text-app-text",
};

export const actionClass = (variant: Variant = "primary") => `${BASE} ${VARIANTS[variant]}`;

export function ActionButton({
  variant = "primary",
  busy = false,
  busyLabel,
  className = "",
  type = "button",
  disabled,
  children,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  variant?: Variant;
  /** The action is running: disabled, and shows `busyLabel` when there is one. */
  busy?: boolean;
  busyLabel?: string;
}) {
  return (
    <button
      type={type}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={`${actionClass(variant)} ${className}`.trim()}
      {...props}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

export function ActionLink({
  variant = "primary",
  className = "",
  ...props
}: ComponentPropsWithoutRef<"a"> & { variant?: Variant }) {
  return <a className={`${actionClass(variant)} ${className}`.trim()} {...props} />;
}
