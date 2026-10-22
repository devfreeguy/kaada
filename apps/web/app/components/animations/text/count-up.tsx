"use client";

// Adapted from the React Bits CountUp source supplied for this project.
import { RevealContext } from "../reveal-context";
import { useRevealMargin } from "../use-reveal-margin";
import { animate, useInView } from "framer-motion";
import { usePageScrollViewport } from "../../page-scroll-area";
import { useTextReducedMotion } from "./use-text-reduced-motion";
import {
  CELL,
  STAGGER,
  SLOT_STYLE,
  SR_ONLY,
  clamp01,
  smooth,
  mod10,
  makeSpring,
  EASINGS,
  getDecimalPlaces,
  scaleFor,
  splitNumber,
  group,
  buildRoll,
} from "./count-up-utils";
import type { CountUpProps, CountUpPlay, CountUpLive, RollMark } from "./count-up-types";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function CountUp({
  to,
  from = 0,
  direction = "up",
  delay = 0,
  duration = 2,
  className = "",
  style,
  startWhen = true,
  separator = "",
  prefix = "",
  suffix = "",
  mode = "count",
  easing = "easeOut",
  decimals: requestedDecimals,
  format = "standard",
  trigger = "view",
  replayOnHover = false,
  onStart,
  onEnd,
}: CountUpProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const root = usePageScrollViewport();
  const reducedMotion = useTextReducedMotion();
  const decimals =
    requestedDecimals === undefined
      ? undefined
      : Math.min(20, Math.max(0, Math.trunc(requestedDecimals)));
  const textRef = useRef<HTMLSpanElement | null>(null);
  const slotRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const filterRefs = useRef<(SVGFEGaussianBlurElement | null)[]>([]);
  const uid = useId().replace(/[^\w-]/g, "");
  const startValue = direction === "down" ? to : from;
  const endValue = direction === "down" ? from : to;
  const valueRef = useRef(startValue);
  const startedRef = useRef(false);
  const runningRef = useRef(false);
  const [play, setPlay] = useState<CountUpPlay | null>(null);
  const startedPlay = useRef<number | null>(null);
  const completedPlay = useRef<number | null>(null);
  const margin = useRevealMargin();
  const isInView = useInView(ref, { root, once: true, margin });
  const parentReveal = useContext(RevealContext);
  const active = parentReveal ? parentReveal.active : trigger === "load" || isInView;
  const compact = format === "compact";
  const places = decimals ?? Math.max(getDecimalPlaces(from), getDecimalPlaces(to));

  const formatValue = useCallback(
    (latest: number) => {
      const { size, label, digits } = scaleFor(latest, compact, decimals, places);
      const parts = splitNumber(latest, digits, size);
      const body = `${parts.negative ? "-" : ""}${group(parts.int, separator)}${parts.frac ? `.${parts.frac}` : ""}`;
      return `${prefix}${body}${label}${suffix}`;
    },
    [compact, decimals, places, separator, prefix, suffix],
  );

  const model = useMemo(() => {
    if (mode !== "roll" || !play) return null;
    const a = play ? play.from : startValue;
    const b = play ? play.to : endValue;
    return buildRoll(a, b, !!play?.spin, { compact, decimals, places, separator });
  }, [mode, play, startValue, endValue, compact, decimals, places, separator]);

  const [initialText] = useState(() => formatValue(endValue));
  const latestRef = useRef<CountUpLive | null>(null);

  useIsoLayoutEffect(() => {
    latestRef.current = {
      formatValue,
      onStart,
      onEnd,
      model,
      mode,
      easing,
      duration: Math.max(0, duration),
      delay,
    };
  });

  useIsoLayoutEffect(() => {
    if (!startedRef.current) valueRef.current = startValue;
    if (mode === "count" && !runningRef.current && textRef.current) {
      textRef.current.textContent = formatValue(valueRef.current);
    }
  }, [mode, startValue, formatValue]);

  useEffect(() => {
    if (!active || !startWhen) return;
    startedRef.current = true;
    setPlay((previous) => ({
      id: (previous?.id || 0) + 1,
      from: valueRef.current,
      to: endValue,
      spin: false,
      wait: true,
    }));
  }, [active, startWhen, endValue]);

  useEffect(() => {
    if (!play || !latestRef.current) return undefined;
    const live = latestRef.current;
    const ease = EASINGS[live.easing] || EASINGS.easeOut;
    const total = live.duration;
    const progress = (t: number) => (total > 0 ? clamp01(t / total) : 1);
    let render: (time: number) => void;

    if (live.mode === "roll" && live.model && ref.current) {
      const { columns: layout, slots } = live.model;
      const fontSize = parseFloat(getComputedStyle(ref.current).fontSize) || 16;
      const cell = CELL * fontSize;
      const stagger =
        layout.length > 1 ? Math.min(STAGGER, (total * 0.4) / (layout.length - 1)) : 0;
      const span = Math.max(0.001, total - stagger * (layout.length - 1));
      const columns = layout.map((column) => {
        const box = slotRefs.current[column.slot];
        const child = box?.firstElementChild;
        const strip = child instanceof HTMLElement ? child : null;
        return {
          ...column,
          box,
          strip,
          blur: filterRefs.current[column.index],
          cells: strip ? Array.from(strip.childNodes, (node) => node.firstChild) : [],
          width: box ? box.scrollWidth : 0,
          ease:
            live.easing === "spring"
              ? makeSpring(
                  Math.min(0.12, Math.max(0.01, 0.35 / Math.max(1, Math.abs(column.delta)))),
                )
              : ease,
          base: Math.floor(column.from),
          sigma: 0,
          presence: column.enter ? 0 : 1,
        };
      });
      const marks = slots
        .map((slot, index) => ({ ...slot, node: slotRefs.current[index] }))
        .filter(
          (slot): slot is RollMark & { node: HTMLSpanElement } =>
            slot.char !== undefined &&
            !!slot.node &&
            !!(slot.enter || slot.leave || slot.follow !== undefined),
        )
        .map((slot) => ({ ...slot, width: slot.node.scrollWidth }));

      const fade = (
        node: HTMLElement | null | undefined,
        width: number,
        presence: number,
        settled: boolean,
      ) => {
        if (!node) return;
        node.style.width = settled ? "" : `${(presence * width).toFixed(2)}px`;
        node.style.opacity = settled ? "" : presence.toFixed(3);
      };

      render = (t: number) => {
        columns.forEach((column, index) => {
          if (!column.strip) return;
          const u = clamp01((t - index * stagger) / span);
          const pos = column.from + column.delta * column.ease(u);
          const base = Math.floor(pos);
          if (base !== column.base) {
            column.base = base;
            column.cells.forEach((node, offset) => {
              if (node) node.nodeValue = String(mod10(base + offset - 1));
            });
          }
          column.strip.style.transform = `translateY(${(-(1 + pos - base) * CELL).toFixed(4)}em)`;

          const u0 = Math.max(0, u - 0.004);
          const u1 = Math.min(1, u + 0.004);
          const speed =
            u1 > u0
              ? (Math.abs(column.delta) * Math.abs(column.ease(u1) - column.ease(u0))) /
                (u1 - u0) /
                span
              : 0;
          const sigma = u > 0 && u < 1 ? Math.min(cell * 0.05, (speed * cell) / 600) : 0;
          if (Math.abs(sigma - column.sigma) > 0.05 || (sigma === 0 && column.sigma !== 0)) {
            column.sigma = sigma;
            if (sigma > 0.2 && column.blur) {
              column.blur.setAttribute("stdDeviation", `0 ${sigma.toFixed(2)}`);
              column.strip.style.filter = `url(#${uid}-${index})`;
            } else {
              column.strip.style.filter = "";
            }
          }

          if (column.enter || column.leave) {
            column.presence = column.enter ? smooth(0, 0.45, u) : 1 - smooth(0.55, 1, u);
            fade(column.box, column.width, column.presence, column.enter && u >= 1);
          }
        });

        const overall = progress(t);
        marks.forEach((mark) => {
          if (mark.follow !== undefined) {
            const column = columns[mark.follow];
            if (column && (column.enter || column.leave))
              fade(mark.node, mark.width, column.presence, column.enter && column.presence >= 1);
          } else {
            const presence = mark.enter ? smooth(0, 0.3, overall) : 1 - smooth(0.7, 1, overall);
            fade(mark.node, mark.width, presence, !!mark.enter && overall >= 1);
          }
        });

        valueRef.current = play.from + (play.to - play.from) * ease(overall);
      };
    } else {
      render = (t: number) => {
        const value = play.from + (play.to - play.from) * ease(progress(t));
        valueRef.current = value;
        if (textRef.current)
          textRef.current.textContent = (latestRef.current ?? live).formatValue(value);
      };
    }

    runningRef.current = true;
    if (startedPlay.current !== play.id) {
      startedPlay.current = play.id;
      live.onStart?.();
    }

    const finish = () => {
      render(Infinity);
      valueRef.current = play.to;
      runningRef.current = false;
      if (completedPlay.current !== play.id) {
        completedPlay.current = play.id;
        latestRef.current?.onEnd?.();
      }
    };

    if (
      reducedMotion ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      completedPlay.current === play.id
    ) {
      finish();
      return undefined;
    }

    const controls = animate(0, total, {
      duration: total,
      delay: play.wait ? live.delay : 0,
      ease: "linear",
      onUpdate: render,
      onComplete: finish,
    });

    return () => {
      controls.stop();
      runningRef.current = false;
    };
  }, [play, uid, reducedMotion]);

  const replay = () => {
    if (!replayOnHover || reducedMotion || runningRef.current || !startedRef.current) return;
    setPlay((previous) =>
      mode === "roll"
        ? { id: (previous?.id || 0) + 1, from: valueRef.current, to: valueRef.current, spin: true }
        : { id: (previous?.id || 0) + 1, from: startValue, to: endValue, spin: false },
    );
  };

  const finalText = formatValue(play ? play.to : endValue);

  return (
    <span
      className={className}
      ref={ref}
      style={{ fontVariantNumeric: "tabular-nums", ...style }}
      onPointerEnter={replayOnHover ? replay : undefined}
      tabIndex={replayOnHover ? 0 : undefined}
      role={replayOnHover ? "button" : undefined}
      aria-description={replayOnHover ? "Activate to replay the number animation." : undefined}
      onKeyDown={
        replayOnHover
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                replay();
              }
            }
          : undefined
      }
    >
      {model ? (
        <>
          <span
            key={`roll-${play?.id || 0}`}
            aria-hidden="true"
            style={{ display: "inline-flex", whiteSpace: "pre", userSelect: "none" }}
          >
            {prefix && <span style={SLOT_STYLE}>{prefix}</span>}
            {model.slots.map((slot, index) => {
              const hidden =
                slot.char !== undefined
                  ? slot.enter || (slot.follow !== undefined && model.columns[slot.follow]?.enter)
                  : slot.enter;
              const collapsed = hidden ? { width: 0, opacity: 0 } : null;
              if (slot.char !== undefined) {
                return (
                  <span
                    key={index}
                    ref={(node) => {
                      slotRefs.current[index] = node;
                    }}
                    style={{ ...SLOT_STYLE, overflow: "hidden", ...collapsed }}
                  >
                    {slot.char}
                  </span>
                );
              }
              return (
                <span
                  key={index}
                  ref={(node) => {
                    slotRefs.current[index] = node;
                  }}
                  style={{ ...SLOT_STYLE, position: "relative", overflow: "hidden", ...collapsed }}
                >
                  <span
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      transform: `translateY(${-CELL}em)`,
                    }}
                  >
                    {[-1, 0, 1, 2].map((offset) => (
                      <span key={offset} style={{ height: `${CELL}em` }}>
                        {mod10(slot.from + offset)}
                      </span>
                    ))}
                  </span>
                </span>
              );
            })}
            {model.label && <span style={SLOT_STYLE}>{model.label}</span>}
            {suffix && <span style={SLOT_STYLE}>{suffix}</span>}
          </span>

          <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute" }}>
            <defs>
              {model.columns.map((column) => (
                <filter
                  key={column.index}
                  id={`${uid}-${column.index}`}
                  x="-20%"
                  y="-50%"
                  width="140%"
                  height="200%"
                  colorInterpolationFilters="sRGB"
                >
                  <feGaussianBlur
                    ref={(node) => {
                      filterRefs.current[column.index] = node;
                    }}
                    stdDeviation="0 0"
                  />
                </filter>
              ))}
            </defs>
          </svg>
        </>
      ) : (
        <span key="count" ref={textRef} aria-hidden="true">
          {initialText}
        </span>
      )}
      <span style={SR_ONLY}>{finalText}</span>
    </span>
  );
}
