import type { CSSProperties } from "react";
import type { Easing, MotionStyle } from "framer-motion";

export type BlurTextEffect = "blur" | "zoom" | "tilt" | "focus" | "drift";
export type BlurTextDirection = "top" | "bottom" | "left" | "right";
export type BlurFrame = Record<string, string | number>;
export type BlurEffect = {
  from: BlurFrame;
  steps: BlurFrame[];
  exit: BlurFrame;
  times: number[];
  fade: Easing;
  bounce: number | null;
  settle: number;
  origin?: MotionStyle;
  exitEase: Easing;
};
export type BlurTextProps = {
  text?: string;
  tag?: "p" | "span";
  className?: string;
  style?: CSSProperties;
  effect?: BlurTextEffect;
  animateBy?: "words" | "letters";
  direction?: BlurTextDirection;
  staggerFrom?: "start" | "center" | "end" | "random";
  trigger?: "view" | "load" | "hover" | "click";
  startWhen?: boolean;
  delay?: number;
  /** Seconds before the first piece reveals. */
  initialDelay?: number;
  stepDuration?: number;
  loop?: boolean;
  loopDelay?: number;
  blur?: number;
  distance?: number;
  color?: string;
  fromColor?: string;
  focusOnHover?: boolean;
  threshold?: number;
  rootMargin?: string;
  animationFrom?: BlurFrame;
  animationTo?: BlurFrame[];
  easing?: Easing | Easing[];
  onAnimationComplete?: () => void;
};
