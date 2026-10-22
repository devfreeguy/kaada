"use client";

import { useRef, type ReactNode } from "react";
import { RevealContext } from "../../components/animations/reveal-context";
import { useAnimationFontReady } from "../../components/animations/text/use-animation-font-ready";

export function HeroHeadingEntrance({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const ready = useAnimationFontReady(ref, "MOVING MONEY ACROSS BORDERS SHOULD FEEL THIS SIMPLE");
  return (
    <h1 ref={ref} className={className}>
      <RevealContext value={{ active: ready, delay: 0 }}>{children}</RevealContext>
    </h1>
  );
}
