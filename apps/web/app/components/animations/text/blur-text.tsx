"use client";

// Adapted from the React Bits source supplied for Kaada.
import { motion, MotionConfig } from "framer-motion";
import type { MotionStyle, Transition } from "framer-motion";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { usePageScrollViewport } from "../../page-scroll-area";
import { useTextReducedMotion } from "./use-text-reduced-motion";
import type { BlurTextProps } from "./blur-text-types";
import {
  buildEffect,
  buildKeyframes,
  buildRanks,
  CSS_EASE,
  INSTANT,
  MOVE_KEYS,
  PIECE_STYLE,
  SR_ONLY,
  WORD_STYLE,
} from "./blur-text-effects";
type Phase = "in" | "out" | "rest" | "from";
const startPhase = (trigger: BlurTextProps["trigger"]): Phase =>
  trigger === "load" ? "in" : trigger === "hover" || trigger === "click" ? "rest" : "from";
const BlurTextAnimation = ({
  text = "",
  tag: Tag = "p",
  delay = 200,
  initialDelay = 0,
  className = "",
  style,
  animateBy = "words",
  direction = "top",
  threshold = 0.1,
  rootMargin = "0px",
  animationFrom,
  animationTo,
  easing,
  onAnimationComplete,
  stepDuration = 0.35,
  blur = 10,
  distance = 50,
  effect = "blur",
  staggerFrom = "start",
  trigger = "view",
  startWhen = true,
  loop = false,
  loopDelay = 2,
  color,
  fromColor,
  focusOnHover = false,
}: BlurTextProps) => {
  const ref = useRef<HTMLElement>(null);
  const scrollRoot = usePageScrollViewport();
  const reducedMotion = useTextReducedMotion();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const [phase, setPhase] = useState<Phase>(() => startPhase(trigger));

  const [focusWord, setFocusWord] = useState(-1);
  const settledRef = useRef(phase === "rest");
  const completeRef = useRef(onAnimationComplete);
  useLayoutEffect(() => {
    completeRef.current = onAnimationComplete;
  });

  const fx = useMemo(
    () => buildEffect(effect, direction, blur, distance),
    [effect, direction, blur, distance],
  );

  const custom = Boolean(animationFrom || animationTo || easing);
  const fromSnapshot = animationFrom ?? fx.from;
  const toSnapshots = animationTo?.length ? animationTo : fx.steps;
  const exitSnapshot = animationFrom ?? fx.exit;
  const restSnapshot = toSnapshots[toSnapshots.length - 1] ?? fx.from;
  const animateKeyframes = useMemo(
    () => buildKeyframes(fromSnapshot, custom ? toSnapshots : [restSnapshot]),
    [fromSnapshot, toSnapshots, restSnapshot, custom],
  );

  const stepCount = toSnapshots.length + 1;
  const totalDuration = Math.max(0, stepDuration) * (stepCount - 1);
  const times = animationTo
    ? Array.from({ length: stepCount }, (_, i) => (stepCount === 1 ? 0 : i / (stepCount - 1)))
    : fx.times;
  const stagger = Math.max(0, delay) / 1000;
  const exitDuration = Math.max(0, stepDuration) * 1.3;
  const exitStagger = stagger * 0.4;

  const words = useMemo(() => text.split(" "), [text]);

  const pieces = useMemo(() => {
    const list: { word: number; content: string; key: string }[] = [];
    words.forEach((word, w) => {
      if (animateBy === "words") {
        list.push({ word: w, content: word, key: `word-${w}` });
        return;
      }
      Array.from(word).forEach((char, c) =>
        list.push({ word: w, content: char, key: `char-${w}-${c}` }),
      );
    });
    return list;
  }, [words, animateBy]);

  const groups = useMemo(() => {
    const list: number[][] = words.map(() => []);
    pieces.forEach((piece, index) => list[piece.word]?.push(index));
    return list;
  }, [words, pieces]);

  const ranks = useMemo(
    () => buildRanks(pieces.length, staggerFrom, text),
    [pieces.length, staggerFrom, text],
  );
  const maxRank = ranks.reduce((max, rank) => Math.max(max, rank), 0);
  const inTotal =
    Math.max(0, initialDelay) * 1000 +
    (totalDuration * (custom ? 1 : Math.max(1, fx.settle * 2.2)) + maxRank * stagger) * 1000;
  const outTotal = (exitDuration + maxRank * exitStagger) * 1000;

  useEffect(() => {
    if (!armed || !startWhen || reducedMotion || phase !== "from") return undefined;
    const element = ref.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setPhase((current) => (current === "from" ? "in" : current));
          observer.disconnect();
        }
      },
      {
        root: scrollRoot.current ?? element.closest("#page-scroll-viewport"),
        threshold: Math.min(1, Math.max(0, threshold)),
        rootMargin,
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [phase, trigger, threshold, rootMargin, scrollRoot, armed, reducedMotion, startWhen]);

  useEffect(() => {
    if (!armed || !startWhen || reducedMotion) return;
    let timer = 0;
    if (phase === "in") {
      settledRef.current = false;
      timer = window.setTimeout(() => {
        settledRef.current = true;
        completeRef.current?.();
        setPhase("rest");
      }, inTotal);
    } else if (phase === "rest") {
      settledRef.current = true;
      if (loop) timer = window.setTimeout(() => setPhase("out"), Math.max(0, loopDelay) * 1000);
    } else if (phase === "out") {
      settledRef.current = false;
      timer = window.setTimeout(() => setPhase("in"), outTotal);
    }
    return () => window.clearTimeout(timer);
  }, [phase, loop, loopDelay, inTotal, outTotal, armed, reducedMotion, startWhen]);

  const replay = () => {
    if (reducedMotion || phase === "out" || phase === "from") return;
    setPhase("out");
  };

  const handleEnter = () => {
    if (settledRef.current) replay();
  };

  const inTransition = (rank: number): Transition => {
    const delayed = Math.max(0, initialDelay) + rank * stagger;
    if (custom) return { duration: totalDuration, times, delay: delayed, ease: easing ?? "linear" };
    const transition: Transition = { duration: totalDuration, delay: delayed, ease: fx.fade };
    if (fx.bounce === null) return transition;
    const move = {
      type: "spring" as const,
      visualDuration: totalDuration * fx.settle,
      bounce: fx.bounce,
      delay: delayed,
    };
    return {
      ...transition,
      ...Object.fromEntries(
        MOVE_KEYS.filter((key) => key in fromSnapshot).map((key) => [key, move]),
      ),
    };
  };

  const target =
    phase === "in"
      ? animateKeyframes
      : phase === "out"
        ? exitSnapshot
        : phase === "rest"
          ? restSnapshot
          : fromSnapshot;
  const tinted =
    armed && !reducedMotion && Boolean(fromColor) && (phase === "from" || phase === "out");
  const dim = Math.min(6, Math.max(2, blur * 0.3));
  const pieceStyle = fx.origin && !custom ? { ...PIECE_STYLE, ...fx.origin } : PIECE_STYLE;

  const renderPiece = (index: number) => {
    const piece = pieces[index];
    if (!piece) return null;
    const rank = ranks[index] ?? 0;
    const transition: Transition =
      phase === "in"
        ? inTransition(rank)
        : phase === "out"
          ? { duration: exitDuration, ease: fx.exitEase, delay: rank * exitStagger }
          : INSTANT;
    const style: MotionStyle = fromColor
      ? {
          ...pieceStyle,
          color: tinted ? fromColor : undefined,
          transition:
            phase === "in"
              ? `color ${totalDuration * 0.9}s ${CSS_EASE} ${rank * stagger}s`
              : phase === "out"
                ? `color ${exitDuration}s ${CSS_EASE} ${rank * exitStagger}s`
                : "none",
        }
      : pieceStyle;

    return (
      <motion.span
        aria-hidden="true"
        key={piece.key}
        style={style}
        initial={false}
        animate={!armed || reducedMotion ? restSnapshot : !startWhen ? fromSnapshot : target}
        transition={!armed || reducedMotion ? INSTANT : transition}
      >
        {piece.content}
      </motion.span>
    );
  };

  const wordStyle = (w: number): CSSProperties => {
    if (!focusOnHover || reducedMotion) return WORD_STYLE;
    const dimmed = focusWord !== -1 && focusWord !== w;
    return {
      ...WORD_STYLE,
      filter: dimmed ? `blur(${dim}px)` : "blur(0px)",
      opacity: dimmed ? 0.3 : 1,
      transition: `filter 0.45s ${CSS_EASE}, opacity 0.45s ${CSS_EASE}`,
    };
  };

  return (
    <MotionConfig reducedMotion="user">
      <Tag
        ref={(node) => {
          ref.current = node;
        }}
        className={className}
        style={{
          color,
          cursor: trigger === "click" ? "pointer" : undefined,
          ...style,
        }}
        tabIndex={trigger === "click" || trigger === "hover" ? 0 : undefined}
        role={trigger === "click" || trigger === "hover" ? "button" : undefined}
        onKeyDown={(event) => {
          if (
            (trigger === "click" || trigger === "hover") &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            replay();
          }
        }}
        onPointerEnter={trigger === "hover" ? handleEnter : undefined}
        onClick={trigger === "click" ? replay : undefined}
      >
        {(trigger === "view" || trigger === "load") &&
        !loop &&
        !focusOnHover &&
        (!armed || reducedMotion || phase === "rest") ? (
          text
        ) : (
          <>
            <span style={SR_ONLY}>{text}</span>
            {groups.map((indices, w) => (
              <Fragment key={`group-${w}`}>
                <span
                  key={`word-${w}`}
                  style={wordStyle(w)}
                  onPointerEnter={focusOnHover ? () => setFocusWord(w) : undefined}
                  onPointerLeave={focusOnHover ? () => setFocusWord(-1) : undefined}
                >
                  {indices.map(renderPiece)}
                </span>
                {w < words.length - 1 ? " " : null}
              </Fragment>
            ))}
          </>
        )}
      </Tag>
    </MotionConfig>
  );
};

export default function BlurText(props: BlurTextProps) {
  return (
    <BlurTextAnimation
      key={`${props.text ?? ""}:${props.trigger ?? "view"}:${props.animateBy ?? "words"}`}
      {...props}
    />
  );
}
