"use client";

import { useLayoutEffect, useRef } from "react";
import { useInView } from "framer-motion";
import { usePageScrollViewport } from "../../page-scroll-area";
import { useRevealMargin } from "../use-reveal-margin";
import { useTextReducedMotion } from "./use-text-reduced-motion";

/** One browser-native animation per text block; no word splitting, filters, or permanent layers. */
export function TextReveal({
  text,
  tag: Tag = "p",
  className,
  id,
  active,
  delay = 0,
}: {
  text: string;
  tag?: "p" | "span" | "h2" | "h3" | "h4";
  className?: string;
  id?: string | undefined;
  active?: boolean | undefined;
  delay?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const unobserved = useRef<HTMLElement>(null);
  const root = usePageScrollViewport();
  const margin = useRevealMargin();
  const inView = useInView(active === undefined ? ref : unobserved, { root, once: true, margin });
  const entered = active ?? inView;
  const reduced = useTextReducedMotion();
  const completed = useRef(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (reduced || completed.current || typeof element.animate !== "function") {
      element.style.opacity = "1";
      return;
    }
    if (!entered) return;
    const animation = element.animate(
      Tag === "span"
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "none" },
          ],
      {
        duration: 320,
        delay: Math.max(0, delay) * 1000,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "both",
      },
    );
    animation.onfinish = () => {
      completed.current = true;
      element.style.opacity = "1";
      animation.cancel();
    };
    return () => {
      animation.onfinish = null;
      animation.cancel();
    };
  }, [entered, reduced, delay, Tag]);

  return (
    <Tag
      ref={(node) => {
        ref.current = node;
      }}
      className={className}
      id={id}
      data-text-reveal
      style={{ opacity: 0 }}
    >
      {text}
    </Tag>
  );
}
