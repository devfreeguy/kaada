import type { TargetAndTransition } from "framer-motion";

export type TransitionPreset = {
  kind: "slide" | "fade" | "pop";
  direction?: "up" | "down";
  distance?: number;
  fromScale?: number;
};

export function createTransitionStates(preset: TransitionPreset, reducedMotion: boolean) {
  const visible: TargetAndTransition = { opacity: 1, y: 0, scale: 1 };
  const hidden: TargetAndTransition = { opacity: 0, y: 0, scale: 1 };
  const exit: TargetAndTransition = { ...hidden };
  if (!reducedMotion && preset.kind === "slide") {
    const offset = Math.max(0, preset.distance ?? 32) * (preset.direction === "down" ? -1 : 1);
    hidden.y = offset;
    exit.y = -offset;
  }
  if (!reducedMotion && preset.kind === "pop") {
    hidden.scale = Math.min(1, Math.max(0.01, preset.fromScale ?? 0.9));
    hidden.y = Math.max(0, preset.distance ?? 0);
    exit.y = hidden.y;
    exit.scale = hidden.scale;
  }
  return { hidden, visible, exit };
}
