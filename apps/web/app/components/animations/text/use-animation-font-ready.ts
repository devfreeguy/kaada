"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/** Wait for this element's font, rather than blocking on every font used by the page. */
export function useAnimationFontReady(
  ref: RefObject<HTMLElement | null>,
  text: string,
  selector?: string,
) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const element = selector ? ref.current?.querySelector<HTMLElement>(selector) : ref.current;
    if (!element) return;
    let active = true;
    const style = getComputedStyle(element);
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const finish = () => {
      if (active) setReady(true);
    };
    void document.fonts.load(font, text || "Kaada").then(finish, finish);
    return () => {
      active = false;
    };
  }, [ref, text, selector]);
  return ready;
}
