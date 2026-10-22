"use client";

// Adapted from the React Bits SplitText source supplied for this project.

import { useEffect, useLayoutEffect, useRef } from "react";
import { useAnimationFontReady } from "./use-animation-font-ready";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText as GSAPSplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";
import { usePageScrollViewport } from "../../page-scroll-area";
import { useTextReducedMotion } from "./use-text-reduced-motion";
import { DEFAULT_FROM, DEFAULT_TO, getEffect } from "./split-text-effects";
import type { SplitTextProps } from "./split-text-types";

gsap.registerPlugin(ScrollTrigger, GSAPSplitText, useGSAP);

const STIFFNESS = 180;
const DAMPING = 19;
const KICK = 0.024;
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const SplitText = ({
  text = "",
  className = "",
  delay = 50,
  duration = 1.25,
  ease,
  splitType = "chars",
  from,
  to,
  threshold = 0.1,
  rootMargin = "-100px",
  textAlign = "center",
  tag = "p",
  staggerFrom = "start",
  mask = false,
  effect = "rise",
  trigger = "view",
  startWhen = true,
  initialDelay = 0,
  restoreAfterReveal = false,
  loop = false,
  loopDelay = 1.5,
  hoverEffect = "none",
  color,
  accentColor,
  onLetterAnimationComplete,
}: SplitTextProps) => {
  const ref = useRef<HTMLElement | null>(null);
  const scrollViewport = usePageScrollViewport();
  const reducedMotion = useTextReducedMotion();
  const completedTextRef = useRef<string | null>(null);
  const onCompleteRef = useRef(onLetterAnimationComplete);
  const liveRef = useRef({ trigger, hoverEffect, accentColor });
  const fontsLoaded = useAnimationFontReady(ref, text);

  useIsoLayoutEffect(() => {
    onCompleteRef.current = onLetterAnimationComplete;
    liveRef.current = { trigger, hoverEffect, accentColor };
  });

  useGSAP(
    () => {
      const el = ref.current;
      if (!el || !text || !fontsLoaded) return;
      // Child layout effects can run before the parent Scroll Area ref attaches.
      const scroller = scrollViewport.current ?? el.closest<HTMLElement>("#page-scroll-viewport");
      el.getBoundingClientRect();

      const finish = () => {
        if (completedTextRef.current === text) return;
        completedTextRef.current = text;
        onCompleteRef.current?.();
      };

      if (reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        finish();
        return;
      }

      if (restoreAfterReveal && completedTextRef.current === text) return;

      if (!startWhen) {
        gsap.set(el, { opacity: 0 });
        return;
      }

      const startPct = (1 - threshold) * 100;
      const marginMatch = /^(-?\d+(?:\.\d+)?)(px|em|rem|%)?$/.exec(rootMargin);
      const marginValue = marginMatch ? parseFloat(marginMatch[1] ?? "0") : 0;
      const marginUnit = marginMatch ? marginMatch[2] || "px" : "px";
      const sign =
        marginValue === 0
          ? ""
          : marginValue < 0
            ? `-=${Math.abs(marginValue)}${marginUnit}`
            : `+=${marginValue}${marginUnit}`;
      const start = `top ${startPct}%${sign}`;
      const unit = splitType.includes("chars")
        ? "chars"
        : splitType.includes("words")
          ? "words"
          : "lines";

      const em = parseFloat(getComputedStyle(el).fontSize) || 16;
      const custom = from !== undefined || to !== undefined;
      const look = getEffect(effect, em);
      const fromVars = custom ? { ...(from || DEFAULT_FROM) } : look.from;
      const toVars = custom ? { ...(to || DEFAULT_TO) } : look.to;
      const easing = ease || (custom ? "power3.out" : look.ease);
      const settle = custom ? "willChange" : "transform,filter,willChange";
      const exit = Math.max(0.35, duration * 0.55);

      let pieces: HTMLElement[] = [];
      let movers: HTMLElement[] = [];
      let order = gsap.utils.distribute({ each: delay / 1000, from: staggerFrom });
      let revealed = completedTextRef.current === text;
      let intro: gsap.core.Timeline | null = null;
      let busy: gsap.core.Timeline | null = null;
      let queued: gsap.core.Tween | null = null;
      let raf = 0;
      let last = 0;
      let centers: { x: number; y: number }[] | null = null;
      const lift = em * 0.2;
      const springs: { y: number; v: number }[] = [];
      const kicks: { index: number; at: number; velocity: number }[] = [];
      const pointer = { x: 0, y: 0, inside: false };

      const reveal = (initial: boolean, vars: gsap.TimelineVars = {}) => {
        const accent = liveRef.current.accentColor;
        const tl = gsap.timeline(vars);
        tl.fromTo(
          pieces,
          { ...fromVars, willChange: "transform, opacity" },
          { ...toVars, duration, ease: easing, stagger: order, immediateRender: initial },
          0,
        );
        if (accent) {
          tl.fromTo(
            pieces,
            { color: accent },
            {
              color: getComputedStyle(el).color,
              duration: duration * 0.7,
              ease: "power1.inOut",
              stagger: order,
              immediateRender: initial,
            },
            duration * 0.3,
          );
        }
        tl.set(pieces, { clearProps: accent ? `${settle},color` : settle });
        return tl;
      };

      const conceal = () => {
        const accent = liveRef.current.accentColor;
        const tl = gsap.timeline();
        tl.fromTo(
          pieces,
          { ...toVars, willChange: "transform, opacity" },
          {
            ...fromVars,
            duration: exit,
            ease: "power2.in",
            stagger: order,
            immediateRender: false,
          },
          0,
        );
        if (accent)
          tl.to(pieces, { color: accent, duration: exit, ease: "power1.in", stagger: order }, 0);
        return tl;
      };

      const cycle = () => {
        if (busy || !revealed || !pieces.length) return;
        queued?.kill();
        queued = null;
        busy = gsap
          .timeline({
            onComplete: () => {
              busy = null;
              queue();
            },
          })
          .add(conceal(), 0)
          .add(reveal(false));
      };

      const queue = () => {
        queued?.kill();
        queued = loop ? gsap.delayedCall(loopDelay, cycle) : null;
      };

      const measure = () => {
        const box = el.getBoundingClientRect();
        centers = movers.map((node, i) => {
          const rect = node.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2 - box.left,
            y: rect.top + rect.height / 2 - box.top - (springs[i]?.y || 0),
          };
        });
      };

      const tick = (now: number) => {
        raf = 0;
        const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000));
        last = now;
        const spots =
          liveRef.current.hoverEffect === "lift" && pointer.inside && revealed ? centers : null;
        const radius = em * 1.15;
        let moving = false;
        for (let k = kicks.length - 1; k >= 0; k--) {
          const kick = kicks[k];
          if (!kick || now < kick.at) continue;
          const spring = springs[kick.index];
          if (spring) spring.v -= kick.velocity;
          kicks.splice(k, 1);
        }
        movers.forEach((node, i) => {
          const spring = springs[i] || (springs[i] = { y: 0, v: 0 });
          const spot = spots?.[i];
          let target = 0;
          if (spot) {
            const dx = (spot.x - pointer.x) / radius;
            const dy = (spot.y - pointer.y) / (radius * 1.4);
            target = -lift * Math.exp(-(dx * dx + dy * dy) * 0.5);
          }
          spring.v += (STIFFNESS * (target - spring.y) - DAMPING * spring.v) * dt;
          spring.y += spring.v * dt;
          if (Math.abs(target - spring.y) < 0.02 && Math.abs(spring.v) < 0.05) {
            spring.y = target;
            spring.v = 0;
          } else {
            moving = true;
          }
          node.style.translate = Math.abs(spring.y) > 0.01 ? `0 ${spring.y.toFixed(2)}px` : "";
        });
        if (moving || kicks.length) raf = requestAnimationFrame(tick);
      };

      const wake = () => {
        if (raf) return;
        last = performance.now();
        raf = requestAnimationFrame(tick);
      };

      const locate = (e: PointerEvent) => {
        const box = el.getBoundingClientRect();
        pointer.x = e.clientX - box.left;
        pointer.y = e.clientY - box.top;
      };

      const onEnter = (e: PointerEvent) => {
        locate(e);
        pointer.inside = true;
        if (!revealed) return;
        const live = liveRef.current;
        if (live.trigger === "hover") cycle();
        if (live.hoverEffect === "none") return;
        measure();
        if (live.hoverEffect === "wave") {
          const now = performance.now();
          const speed = em * 9;
          const velocity = (em * 0.16) / KICK;
          centers?.forEach((center, index) => {
            kicks.push({
              index,
              velocity,
              at: now + (Math.abs(center.x - pointer.x) / speed) * 1000,
            });
          });
        }
        wake();
      };

      const onMove = (e: PointerEvent) => {
        locate(e);
        pointer.inside = true;
        if (!revealed || liveRef.current.hoverEffect !== "lift") return;
        if (!centers) measure();
        wake();
      };

      const onLeave = () => {
        pointer.inside = false;
        wake();
      };

      const onFocus = () => {
        if (liveRef.current.trigger === "hover") cycle();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (
          (liveRef.current.trigger === "click" || liveRef.current.trigger === "hover") &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          cycle();
        }
      };
      const onClick = () => {
        if (liveRef.current.trigger === "click") cycle();
      };

      const splitInstance = new GSAPSplitText(el, {
        type: splitType,
        smartWrap: true,
        autoSplit: splitType.includes("lines"),
        ...(mask ? { mask: unit } : {}),
        linesClass: "split-line",
        wordsClass: "split-word",
        charsClass: "split-char",
        reduceWhiteSpace: false,
        onSplit: (self) => {
          pieces = (
            [self[unit], self.chars, self.words, self.lines].find((list) => list.length) || []
          ).filter((node): node is HTMLElement => node instanceof HTMLElement);
          movers =
            mask && self.masks.length === pieces.length
              ? self.masks.filter((node): node is HTMLElement => node instanceof HTMLElement)
              : pieces;
          order = gsap.utils.distribute({ each: delay / 1000, from: staggerFrom });
          centers = null;
          springs.length = 0;
          kicks.length = 0;
          if (busy && busy !== intro) {
            busy.kill();
            busy = null;
          }
          if (revealed) return undefined;
          intro = reveal(true, {
            delay: Math.max(0, initialDelay),
            ...(trigger === "load"
              ? {}
              : {
                  scrollTrigger: {
                    trigger: el,
                    ...(scroller ? { scroller } : {}),
                    start,
                    once: true,
                    fastScrollEnd: true,
                    anticipatePin: 0.4,
                  },
                }),
            onComplete: () => {
              revealed = true;
              intro = null;
              busy = null;
              finish();
              queue();
              if (
                restoreAfterReveal &&
                !loop &&
                hoverEffect === "none" &&
                (trigger === "load" || trigger === "view")
              )
                splitInstance.revert();
            },
          });
          busy = intro;
          return intro;
        },
      });
      if (revealed) queue();

      el.addEventListener("pointerenter", onEnter);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerleave", onLeave);
      el.addEventListener("click", onClick);
      el.addEventListener("focus", onFocus);
      el.addEventListener("keydown", onKeyDown);

      return () => {
        cancelAnimationFrame(raf);
        queued?.kill();
        busy?.kill();
        el.removeEventListener("pointerenter", onEnter);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
        el.removeEventListener("click", onClick);
        el.removeEventListener("focus", onFocus);
        el.removeEventListener("keydown", onKeyDown);
        movers.forEach((node) => {
          node.style.translate = "";
        });

        splitInstance.revert();
      };
    },
    {
      dependencies: [
        text,
        delay,
        duration,
        ease,
        splitType,
        from,
        to,
        threshold,
        rootMargin,
        staggerFrom,
        mask,
        effect,
        trigger,
        startWhen,
        initialDelay,
        restoreAfterReveal,
        loop,
        loopDelay,
        fontsLoaded,
        reducedMotion,
        tag,
        scrollViewport,
      ],
      scope: ref,
      revertOnUpdate: true,
    },
  );

  const Tag = tag || "p";
  const clip =
    hoverEffect === "none" &&
    (from !== undefined || to !== undefined || effect === "rise" || effect === "fade");

  return (
    <Tag
      key={text}
      ref={(node: HTMLElement | null) => {
        ref.current = node;
      }}
      className={`split-parent ${className}`}
      tabIndex={trigger === "click" || trigger === "hover" ? 0 : undefined}
      role={trigger === "click" && (tag === "p" || tag === "span") ? "button" : undefined}
      aria-description={
        trigger === "click" || trigger === "hover"
          ? "Activate to replay the text animation."
          : undefined
      }
      style={{
        textAlign,
        overflow: restoreAfterReveal ? "visible" : clip ? "hidden" : "visible",
        display: restoreAfterReveal && tag === "span" ? "inline" : "inline-block",
        whiteSpace: "normal",
        wordWrap: "break-word",
        ...(color === undefined ? {} : { color }),
        cursor: trigger === "click" ? "pointer" : undefined,
      }}
    >
      {text}
    </Tag>
  );
};

export default SplitText;
