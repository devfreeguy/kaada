import type { SplitTextEffect } from "./split-text-types";

export const DEFAULT_FROM = { opacity: 0, y: 40 };
export const DEFAULT_TO = { opacity: 1, y: 0 };
const waveEase = (t: number) => 1 - Math.cos(t * Math.PI * 1.5) * Math.pow(1 - t, 1.2);

export const getEffect = (
  effect: SplitTextEffect,
  em: number,
): { from: gsap.TweenVars; to: gsap.TweenVars; ease: string | gsap.EaseFunction } => {
  switch (effect) {
    case "fade":
      return { from: { opacity: 0 }, to: { opacity: 1 }, ease: "power2.inOut" };
    case "blur":
      return {
        from: { opacity: 0, filter: `blur(${Math.round(em * 1.4) / 10}px)` },
        to: { opacity: 1, filter: "blur(0px)" },
        ease: "power2.out",
      };
    case "flip": {
      const setup = { transformPerspective: em * 6, transformOrigin: "50% 100%" };
      return {
        from: { ...setup, opacity: 0, rotationX: -90 },
        to: { ...setup, opacity: 1, rotationX: 0 },
        ease: "power3.out",
      };
    }
    case "pop":
      return {
        from: { opacity: 0, scale: 0 },
        to: { opacity: 1, scale: 1 },
        ease: "back.out(1.6)",
      };
    case "skew":
      return {
        from: { transformOrigin: "50% 100%", opacity: 0, x: -em * 0.4, skewX: -24 },
        to: { transformOrigin: "50% 100%", opacity: 1, x: 0, skewX: 0 },
        ease: "expo.out",
      };
    case "wave":
      return { from: { opacity: 0, y: em * 0.45 }, to: { opacity: 1, y: 0 }, ease: waveEase };
    default:
      return { from: { ...DEFAULT_FROM }, to: { ...DEFAULT_TO }, ease: "power3.out" };
  }
};
