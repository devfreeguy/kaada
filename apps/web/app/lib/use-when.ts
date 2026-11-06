"use client";
import { useEffect, useEffectEvent } from "react";

/**
 * Tells the parent that a step is finished, once, when it BECOMES finished. It is deliberately outside the code that did the work:
 * if the parent throws while reacting, the work is still reported as what it was (done), and a parent that passes a new function
 * on every render cannot make it fire again.
 */
export function useWhen(finished: boolean, callback: (() => void) | undefined): void {
  const notify = useEffectEvent(() => callback?.());
  useEffect(() => {
    if (finished) notify();
  }, [finished]);
}
