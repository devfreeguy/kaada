"use client";

import { useContext, useLayoutEffect, useMemo, useRef } from "react";
import { RevealContext } from "../reveal-context";
import {
  motion,
  useAnimationControls,
  useInView,
  useIsPresent,
  useReducedMotion,
} from "framer-motion";
import { usePageScrollViewport } from "../../page-scroll-area";
import { createTransitionStates, type TransitionPreset } from "./transition-presets";
import type { ComponentTransitionProps } from "./transition-types";

export function TransitionItem({
  preset,
  children,
  className,
  style,
  id,
  trigger = "in-view",
  once = true,
  duration = 0.55,
  delay = 0,
  exitDuration = duration * 0.75,
  amount = "some",
  margin = "0px 0px 0px 0px",
  clipEntrance = false,
}: ComponentTransitionProps & { preset: TransitionPreset }) {
  const element = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const unobserved = useRef<HTMLDivElement>(null);
  const parent = useContext(RevealContext);
  const root = usePageScrollViewport();
  const inView = useInView(parent ? unobserved : element, { root, once, amount, margin });
  const reducedMotion = useReducedMotion() ?? false;
  const present = useIsPresent();
  const controls = useAnimationControls();
  const hasEntered = useRef(false);
  const { kind, direction, distance, fromScale } = preset;
  const states = useMemo(
    () =>
      createTransitionStates(
        {
          kind,
          ...(direction === undefined ? {} : { direction }),
          ...(distance === undefined ? {} : { distance }),
          ...(fromScale === undefined ? {} : { fromScale }),
        },
        reducedMotion,
      ),
    [kind, direction, distance, fromScale, reducedMotion],
  );
  const active = parent ? parent.active : trigger === "mount" || inView;
  const revealDelay = Math.max(0, delay) + (parent?.delay ?? 0);
  const transition = {
    duration: reducedMotion ? 0 : Math.max(0, duration),
    delay: reducedMotion ? 0 : revealDelay,
    ease: [0.22, 1, 0.36, 1] as const,
  };
  const exitTransition = useMemo(
    () => ({
      duration: reducedMotion ? 0 : Math.max(0, exitDuration),
      delay: 0,
      ease: [0.22, 1, 0.36, 1] as const,
    }),
    [exitDuration, reducedMotion],
  );

  // The server sends readable content. Arm the animation only after hydration, before paint.
  useLayoutEffect(() => {
    if (clip.current) clip.current.style.overflow = reducedMotion ? "visible" : "hidden";
    controls.set(reducedMotion ? states.visible : states.hidden);
    return () => controls.stop();
  }, [controls, reducedMotion, states]);

  useLayoutEffect(() => {
    if (!present) return;
    if (active) {
      controls.set(reducedMotion ? states.visible : states.hidden);
      hasEntered.current = true;
      void controls.start(states.visible);
    } else if (hasEntered.current) {
      void controls.start(states.exit, exitTransition);
    } else {
      controls.set(states.hidden);
    }
  }, [active, controls, present, states, reducedMotion, exitTransition]);

  const revealImmediately = () => {
    if (!present) return;
    if (clip.current) clip.current.style.overflow = "visible";
    controls.set(states.visible);
  };

  const content = (
    <motion.div
      ref={element}
      id={id}
      className={className}
      style={style ?? {}}
      data-component-transition={kind}
      initial={states.hidden}
      animate={controls}
      transition={transition}
      exit={{
        ...states.exit,
        transition: exitTransition,
      }}
      inert={!present}
      aria-hidden={!present || undefined}
      onFocusCapture={() => {
        revealImmediately();
      }}
      onPointerDownCapture={clipEntrance ? revealImmediately : undefined}
      onAnimationComplete={() => {
        if (active && clip.current) clip.current.style.overflow = "visible";
      }}
    >
      <RevealContext value={{ active: active || reducedMotion, delay: revealDelay }}>
        {children}
      </RevealContext>
    </motion.div>
  );
  return clipEntrance ? <div ref={clip}>{content}</div> : content;
}
