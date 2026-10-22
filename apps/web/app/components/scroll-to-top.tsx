"use client";

import { IconArrowUp } from "@tabler/icons-react";
import { usePageScrollViewport } from "./page-scroll-area";
import { useTextReducedMotion } from "./animations/text/use-text-reduced-motion";

export function ScrollToTop() {
  const viewport = usePageScrollViewport();
  const reducedMotion = useTextReducedMotion();
  return (
    <button
      type="button"
      aria-label="Back to top"
      title="Back to top"
      className="flex size-11 shrink-0 items-center justify-center rounded-full border border-navy bg-navy text-white transition-colors hover:bg-primary hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary motion-reduce:transition-none"
      onClick={() => {
        viewport.current?.scrollTo({ top: 0, behavior: reducedMotion ? "instant" : "smooth" });
        viewport.current?.focus({ preventScroll: true });
      }}
    >
      <IconArrowUp size={20} stroke={1.8} aria-hidden="true" />
    </button>
  );
}
