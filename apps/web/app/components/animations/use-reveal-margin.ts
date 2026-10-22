"use client";

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let observer: ResizeObserver | undefined;
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("resize", notify);
    observer = new ResizeObserver(notify);
    const viewport = document.getElementById("page-scroll-viewport");
    if (viewport) observer.observe(viewport);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("resize", notify);
      observer?.disconnect();
      observer = undefined;
    }
  };
};
const snapshot = () =>
  document.getElementById("page-scroll-viewport")?.clientHeight || window.innerHeight;
const serverSnapshot = () => 0;

/** Pixel margins keep the reveal line at 80% of viewport height on every aspect ratio. */
export function useRevealMargin(): `0px 0px ${number}px 0px` {
  const height = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return `0px 0px ${-Math.round(height * 0.2)}px 0px`;
}
