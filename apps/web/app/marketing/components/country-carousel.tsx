"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import useEmblaCarousel from "embla-carousel-react";
import AutoScroll from "embla-carousel-auto-scroll";
import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";
import styles from "./country-carousel.module.css";

export function CountryCarousel({ children, count }: { children: ReactNode; count: number }) {
  const root = useRef<HTMLDivElement>(null);
  const plugins = useMemo(
    () => [
      AutoScroll({
        speed: 0.7,
        direction: "forward",
        startDelay: 600,
        playOnInit: false,
        stopOnInteraction: true,
        stopOnFocusIn: false,
      }),
    ],
    [],
  );
  const [viewportRef, api] = useEmblaCarousel(
    { loop: true, align: "start", slidesToScroll: 1 },
    plugins,
  );
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { threshold: 0.2 },
    );
    if (root.current) observer.observe(root.current);
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!api) return;
    const select = () => setIndex(api.selectedScrollSnap());
    select();
    api.on("select", select).on("reInit", select);
    return () => {
      api.off("select", select).off("reInit", select);
    };
  }, [api]);
  useEffect(() => {
    if (!api) return;
    const autoScroll = api.plugins().autoScroll;
    const update = () => {
      if (hovered || focused || reducedMotion || !visible || document.hidden) autoScroll?.stop();
      else autoScroll?.play();
    };
    update();
    api.on("pointerUp", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      api.off("pointerUp", update);
      document.removeEventListener("visibilitychange", update);
      autoScroll?.stop();
    };
  }, [api, hovered, focused, reducedMotion, visible]);

  return (
    <div
      ref={root}
      className={styles.carousel}
      role="region"
      aria-roledescription="carousel"
      aria-label="Supported countries and currencies"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div ref={viewportRef} className={styles.viewport}>
        <ul className={styles.track} aria-label="Countries">
          {children}
        </ul>
      </div>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.control}
          aria-label="Previous country"
          onClick={() => api?.scrollPrev(reducedMotion)}
        >
          <IconArrowLeft size={20} aria-hidden="true" />
        </button>
        <span className={styles.counter} aria-live="off">
          {index + 1} / {count}
        </span>
        <button
          type="button"
          className={styles.control}
          aria-label="Next country"
          onClick={() => api?.scrollNext(reducedMotion)}
        >
          <IconArrowRight size={20} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
