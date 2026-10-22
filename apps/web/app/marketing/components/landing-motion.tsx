"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type CSSProperties,
} from "react";
import { RevealContext } from "../../components/animations/reveal-context";
import { motion, useAnimationControls, useInView } from "framer-motion";
import { ComponentTransition } from "../../components/animations/components/component-transition";
import SplitText from "../../components/animations/text/split-text";
import BlurText from "../../components/animations/text/blur-text";
import { useTextReducedMotion } from "../../components/animations/text/use-text-reduced-motion";
import { useRevealMargin } from "../../components/animations/use-reveal-margin";
import { usePageScrollViewport } from "../../components/page-scroll-area";

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  kind?: "slide" | "fade" | "pop";
  load?: boolean;
};

export function Reveal({
  children,
  className,
  delay = 0,
  kind = "slide",
  load = false,
}: RevealProps) {
  const margin = useRevealMargin();
  return (
    <ComponentTransition
      preset={{ kind, distance: 28, fromScale: 0.88 }}
      trigger={load ? "mount" : "in-view"}
      margin={margin}
      duration={0.65}
      delay={delay}
      {...(className ? { className } : {})}
    >
      {children}
    </ComponentTransition>
  );
}

const GroupContext = createContext<boolean | null>(null);

/** Observe a static card or heading without transforming its layout or sticky position. */
export function RevealBoundary({
  children,
  className,
  style,
  "aria-labelledby": labelledBy,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  "aria-labelledby"?: string;
  as?: "div" | "article" | "aside" | "footer";
}) {
  const ref = useRef<HTMLElement>(null);
  const unobserved = useRef<HTMLElement>(null);
  const parent = useContext(RevealContext);
  const root = usePageScrollViewport();
  const margin = useRevealMargin();
  const entered = useInView(parent ? unobserved : ref, { root, once: true, margin });
  return (
    <Tag
      ref={(node) => {
        ref.current = node;
      }}
      className={className}
      style={style}
      aria-labelledby={labelledBy}
      data-reveal-boundary
    >
      <RevealContext value={parent ?? { active: entered, delay: 0 }}>{children}</RevealContext>
    </Tag>
  );
}

/** A single observer starts the whole sequence, including rows still below the viewport. */
export function RevealGroup({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const parent = useContext(RevealContext);
  const unobserved = useRef<HTMLDivElement>(null);
  const root = usePageScrollViewport();
  const margin = useRevealMargin();
  const inView = useInView(parent ? unobserved : ref, { root, once: true, margin });
  const entered = parent ? parent.active : inView;
  return (
    <div ref={ref} className={className} data-reveal-group>
      <GroupContext value={entered}>{children}</GroupContext>
    </div>
  );
}

export function RevealItem({ children, className, delay = 0, kind = "slide" }: RevealProps) {
  const entered = useContext(GroupContext);
  const reduced = useTextReducedMotion();
  const controls = useAnimationControls();
  useLayoutEffect(() => {
    const hidden = {
      opacity: 0,
      y: kind === "slide" || kind === "pop" ? 24 : 0,
      scale: kind === "pop" ? 0.88 : 1,
    };
    if (entered || reduced) void controls.start({ opacity: 1, y: 0, scale: 1 });
    else controls.set(hidden);
    return () => controls.stop();
  }, [entered, reduced, controls, kind]);
  return (
    <motion.div
      className={className}
      data-reveal-item
      initial={false}
      animate={controls}
      transition={{
        duration: reduced ? 0 : 0.6,
        delay: reduced ? 0 : delay,
        ease: [0.22, 1, 0.36, 1],
      }}
      onFocusCapture={() => controls.set({ opacity: 1, y: 0, scale: 1 })}
    >
      <RevealContext value={{ active: entered ?? true, delay }}>{children}</RevealContext>
    </motion.div>
  );
}

export function HeadingText({
  text,
  load = false,
  className,
}: {
  text: string;
  load?: boolean;
  className?: string;
}) {
  const parent = useContext(RevealContext);
  return (
    <SplitText
      tag="span"
      text={text}
      className={className ?? ""}
      restoreAfterReveal
      splitType="words, chars"
      effect="rise"
      duration={0.65}
      delay={18}
      trigger={parent || load ? "load" : "view"}
      startWhen={parent?.active ?? true}
      initialDelay={parent?.delay ?? 0}
      threshold={0.2}
      rootMargin="0px"
      textAlign="inherit"
    />
  );
}

export function DescriptionText({
  text,
  className,
  load = false,
  delay = 0.1,
  tag = "p",
}: {
  text: string;
  className?: string;
  load?: boolean;
  delay?: number;
  tag?: "p" | "span";
}) {
  const rootMargin = useRevealMargin();
  const parent = useContext(RevealContext);
  return (
    <BlurText
      tag={tag}
      text={text}
      className={className ?? ""}
      trigger={parent || load ? "load" : "view"}
      startWhen={parent?.active ?? true}
      rootMargin={rootMargin}
      threshold={0}
      delay={15}
      initialDelay={delay + (parent?.delay ?? 0)}
      stepDuration={0.14}
      blur={6}
      distance={14}
      direction="bottom"
    />
  );
}
