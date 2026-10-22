"use client";

import { ComponentTransition } from "./component-transition";
import type { ComponentTransitionProps } from "./transition-types";

export function FadeTransition(props: ComponentTransitionProps) {
  return <ComponentTransition preset={{ kind: "fade" }} {...props} />;
}
