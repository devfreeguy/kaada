"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import useEmblaCarousel from "embla-carousel-react";
import AutoScroll from "embla-carousel-auto-scroll";
import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";
import { usePageScrollViewport } from "../../components/page-scroll-area";
import styles from "./country-carousel.module.css";

export function CountryCarousel({ children, count }: { children: ReactNode; count: number }) {
  const root = useRef<HTMLDivElement>(null);
  const pageViewport = usePageScrollViewport();
  const plugins = useMemo(
    () => [
      AutoScroll({
        speed: 0.7,
        direction: "forward",
        startDelay: 0,
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
      {
        root: pageViewport.current,
        // Already moving one screen before the carousel comes into view.
        rootMargin: `${pageViewport.current?.clientHeight ?? window.innerHeight}px 0px`,
        threshold: 0,
      },
    );
    if (root.current) observer.observe(root.current);
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, [pageViewport]);
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
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div ref={viewportRef} className={styles.viewport}>
        <ul
          className={styles.track}
          aria-label="Countries"
          onMouseOver={(event) => {
            setHovered(event.target instanceof Element && !!event.target.closest("article"));
          }}
          onMouseLeave={() => setHovered(false)}
        >
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
