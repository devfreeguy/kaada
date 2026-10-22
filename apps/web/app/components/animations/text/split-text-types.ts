import type { CSSProperties } from "react";

export type SplitTextEffect = "rise" | "fade" | "blur" | "flip" | "pop" | "skew" | "wave";
export type SplitTextProps = {
  text?: string;
  tag?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span";
  className?: string;
  effect?: SplitTextEffect;
  splitType?: "chars" | "words" | "lines" | "words, chars" | "lines, words" | "lines, words, chars";
  /** Milliseconds between pieces. Duration and loopDelay use seconds. */
  delay?: number;
  duration?: number;
  ease?: string | gsap.EaseFunction;
  staggerFrom?: "start" | "center" | "end" | "edges" | "random";
  trigger?: "view" | "load" | "hover" | "click";
  startWhen?: boolean;
  initialDelay?: number;
  restoreAfterReveal?: boolean;
  hoverEffect?: "none" | "lift" | "wave";
  loop?: boolean;
  loopDelay?: number;
  mask?: boolean;
  threshold?: number;
  rootMargin?: string;
  textAlign?: CSSProperties["textAlign"];
  color?: string;
  accentColor?: string;
  from?: gsap.TweenVars;
  to?: gsap.TweenVars;
  onLetterAnimationComplete?: () => void;
};
