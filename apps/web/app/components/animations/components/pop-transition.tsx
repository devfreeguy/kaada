"use client";

import { ComponentTransition } from "./component-transition";
import type { PopTransitionProps } from "./transition-types";

export function PopTransition({ fromScale = 0.9, ...props }: PopTransitionProps) {
  return <ComponentTransition preset={{ kind: "pop", fromScale }} {...props} />;
}
