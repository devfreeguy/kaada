"use client";

import { ComponentTransition } from "./component-transition";
import type { SlideTransitionProps } from "./transition-types";

export function SlideTransition({
  direction = "up",
  distance = 32,
  ...props
}: SlideTransitionProps) {
  return <ComponentTransition preset={{ kind: "slide", direction, distance }} {...props} />;
}
