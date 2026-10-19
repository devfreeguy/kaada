import type { ComponentPropsWithoutRef } from "react";

export function SectionWrapper({ className = "", ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={`mx-auto w-full max-w-360 ${className}`} {...props} />;
}
