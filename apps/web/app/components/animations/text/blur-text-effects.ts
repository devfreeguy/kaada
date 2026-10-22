import type { CSSProperties } from "react";
import type { Easing, MotionStyle, TargetAndTransition } from "framer-motion";
import type {
  BlurTextDirection,
  BlurTextEffect,
  BlurTextProps,
  BlurEffect,
  BlurFrame,
} from "./blur-text-types";
const AXES: Record<BlurTextDirection, [string, number]> = {
  top: ["y", -1],
  bottom: ["y", 1],
  left: ["x", -1],
  right: ["x", 1],
};

const EASE_OUT: Easing = [0.33, 1, 0.68, 1];
const EASE_IN_OUT: Easing = [0.65, 0, 0.35, 1];
const EASE_IN: Easing = [0.55, 0, 0.9, 0.45];
export const CSS_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
export const MOVE_KEYS = ["x", "y", "scale", "rotateX", "rotateY", "skewX"] as const;
export const INSTANT = { duration: 0 };

export const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
  userSelect: "none",
};

export const PIECE_STYLE: MotionStyle = {
  display: "inline-block",
  willChange: "transform, filter, opacity",
};
export const WORD_STYLE: CSSProperties = { display: "inline-block" };

const blurTo = (px: number) => `blur(${Math.max(0, px)}px)`;

export const buildEffect = (
  effect: BlurTextEffect,
  direction: BlurTextDirection,
  blur: number,
  distance: number,
): BlurEffect => {
  const [axis, sign] = AXES[direction] || AXES.top;
  const b = Math.max(0, blur);
  const d = distance;

  if (effect === "zoom") {
    return {
      from: { filter: blurTo(b * 1.2), opacity: 0, scale: 1.4, [axis]: sign * d * 0.35 },
      steps: [
        { filter: blurTo(b * 0.2), opacity: 0.9, scale: 0.97, [axis]: -sign * d * 0.03 },
        { filter: blurTo(0), opacity: 1, scale: 1, [axis]: 0 },
      ],
      exit: { filter: blurTo(b), opacity: 0, scale: 0.82, [axis]: -sign * d * 0.2 },
      times: [0, 0.6, 1],
      fade: EASE_OUT,
      bounce: 0.25,
      settle: 0.5,
      exitEase: EASE_IN,
    };
  }

  if (effect === "tilt") {
    const rotate = axis === "y" ? "rotateX" : "rotateY";
    const lean = axis === "y" ? -sign : sign;
    return {
      from: {
        filter: blurTo(b),
        opacity: 0,
        [rotate]: lean * 55,
        [axis]: sign * d * 0.5,
        transformPerspective: 600,
      },
      steps: [
        {
          filter: blurTo(b * 0.15),
          opacity: 0.95,
          [rotate]: -lean * 8,
          [axis]: -sign * d * 0.04,
          transformPerspective: 600,
        },
        { filter: blurTo(0), opacity: 1, [rotate]: 0, [axis]: 0, transformPerspective: 600 },
      ],
      exit: {
        filter: blurTo(b),
        opacity: 0,
        [rotate]: -lean * 40,
        [axis]: -sign * d * 0.3,
        transformPerspective: 600,
      },
      times: [0, 0.6, 1],
      fade: EASE_OUT,
      bounce: 0.3,
      settle: 0.8,
      origin: {
        originX: axis === "x" ? (sign < 0 ? 0 : 1) : 0.5,
        originY: axis === "y" ? (sign < 0 ? 0 : 1) : 0.5,
      },
      exitEase: EASE_IN,
    };
  }

  if (effect === "focus") {
    const soft = { filter: blurTo(b * 1.4), opacity: 0.32, scale: 1.12 };
    return {
      from: soft,
      steps: [
        { filter: blurTo(b * 0.1), opacity: 0.95, scale: 0.995 },
        { filter: blurTo(0), opacity: 1, scale: 1 },
      ],
      exit: soft,
      times: [0, 0.72, 1],
      fade: EASE_IN_OUT,
      bounce: null,
      settle: 1,
      exitEase: EASE_IN_OUT,
    };
  }

  if (effect === "drift") {
    const h = direction === "right" ? 1 : -1;
    const v = axis === "y" ? sign : 0;
    return {
      from: { filter: blurTo(b), opacity: 0, x: h * d * 1.6, y: v * d * 0.3, skewX: h * 28 },
      steps: [
        { filter: blurTo(b * 0.15), opacity: 0.95, x: -h * d * 0.06, y: 0, skewX: -h * 7 },
        { filter: blurTo(0), opacity: 1, x: 0, y: 0, skewX: 0 },
      ],
      exit: { filter: blurTo(b), opacity: 0, x: -h * d * 1.2, y: -v * d * 0.2, skewX: h * 20 },
      times: [0, 0.62, 1],
      fade: EASE_OUT,
      bounce: 0.3,
      settle: 0.55,
      exitEase: EASE_IN,
    };
  }

  return {
    from: { filter: blurTo(b), opacity: 0, [axis]: sign * d },
    steps: [
      { filter: blurTo(b / 2), opacity: 0.5, [axis]: (-sign * d) / 10 },
      { filter: blurTo(0), opacity: 1, [axis]: 0 },
    ],
    exit: { filter: blurTo(b), opacity: 0, [axis]: -sign * d * 0.6 },
    times: [0, 0.5, 1],
    fade: "linear",
    bounce: 0.35,
    settle: 0.5,
    exitEase: EASE_IN,
  };
};

export const buildKeyframes = (from: BlurFrame, steps: BlurFrame[]): TargetAndTransition => {
  const keys = new Set([...Object.keys(from), ...steps.flatMap((s) => Object.keys(s))]);

  const keyframes: Record<string, (string | number)[]> = {};
  keys.forEach((k) => {
    keyframes[k] = [from[k] ?? 0, ...steps.map((s) => s[k] ?? from[k] ?? 0)];
  });
  return keyframes;
};

export const buildRanks = (
  count: number,
  staggerFrom: NonNullable<BlurTextProps["staggerFrom"]>,
  seedText: string,
) => {
  const ranks = Array.from({ length: count }, (_, i) => i);
  if (staggerFrom === "end") return ranks.map((i) => count - 1 - i);
  if (staggerFrom === "center") {
    const mid = (count - 1) / 2;
    const offset = count % 2 === 0 ? 0.5 : 0;
    return ranks.map((i) => Math.abs(i - mid) - offset);
  }
  if (staggerFrom === "random") {
    let seed = 2166136261;
    for (let i = 0; i < seedText.length; i++)
      seed = Math.imul(seed ^ seedText.charCodeAt(i), 16777619) >>> 0;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const order = ranks.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    order.forEach((piece, rank) => {
      ranks[piece] = rank;
    });
  }
  return ranks;
};
