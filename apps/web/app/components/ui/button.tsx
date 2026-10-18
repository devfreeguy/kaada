import type { ComponentPropsWithoutRef } from "react";

type ButtonStyle = {
  variant?: "primary" | "secondary";
  className?: string;
};

function classes({ variant = "primary", className = "" }: ButtonStyle) {
  return `kaada-button kaada-button--${variant} ${className}`.trim();
}

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ComponentPropsWithoutRef<"button"> & ButtonStyle) {
  return <button type={type} className={classes({ variant, className })} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  className = "",
  ...props
}: ComponentPropsWithoutRef<"a"> & ButtonStyle) {
  return <a className={classes({ variant, className })} {...props} />;
}

export function ButtonArrow() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 12h15m-6-6 6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
