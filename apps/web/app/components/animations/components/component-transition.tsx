"use client";

import { AnimatePresence } from "framer-motion";
import { TransitionItem } from "./transition-item";
import type { TransitionPreset } from "./transition-presets";
import type { ComponentTransitionProps } from "./transition-types";

export function ComponentTransition({
  visible = true,
  preset,
  ...props
}: ComponentTransitionProps & { preset: TransitionPreset }) {
  return (
    <AnimatePresence>
      {visible && <TransitionItem key="transition-item" preset={preset} {...props} />}
    </AnimatePresence>
  );
}
