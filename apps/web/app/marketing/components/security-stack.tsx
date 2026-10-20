"use client";

import {
  Children,
  useRef,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useScroll } from "framer-motion";
import { StickyCard_001 } from "@/components/ui/skiper-ui/skiper16";
import { usePageScrollViewport } from "../../components/page-scroll-area";
import styles from "./security-stack.module.css";

export function SecurityStack({ children, heading }: { children: ReactNode; heading: ReactNode }) {
  const viewport = usePageScrollViewport();
  const stack = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({
    top: 16,
    headingTop: 48,
    fitScale: 1,
    cardHeight: 0,
    desktop: false,
  });
  useLayoutEffect(() => {
    const root = section.current;
    const headingElement = header.current;
    const list = stack.current;
    if (!root || !headingElement || !list) return;
    const measure = () => {
      const scroller = viewport.current;
      if (!scroller) return;
      const desktop = scroller.clientWidth >= 1024;
      const tallestCard = Math.max(
        ...Array.from(list.querySelectorAll("article"), (card) => {
          const css = getComputedStyle(card);
          const contentHeights = Array.from(
            card.children,
            (child) => (child as HTMLElement).offsetHeight,
          );
          return Math.ceil(
            parseFloat(css.paddingTop) +
              parseFloat(css.paddingBottom) +
              (desktop
                ? Math.max(...contentHeights)
                : contentHeights.reduce((sum, value) => sum + value, 0) + parseFloat(css.rowGap)),
          );
        }),
      );
      const headingHeight = (headingElement.firstElementChild as HTMLElement).offsetHeight;
      const height = scroller.clientHeight;
      const desktopHeadingTop = 96;
      const gap = desktop ? 64 : 48;
      const top = desktop
        ? desktopHeadingTop + headingHeight + gap
        : Math.max(24, height - tallestCard - 96);
      const headingTop = desktop ? desktopHeadingTop : top - headingHeight - gap;
      const fitScale = desktop ? Math.min(1, Math.max(0.1, (height - top - 60) / tallestCard)) : 1;
      setLayout((previous) =>
        previous.top === top &&
        previous.headingTop === headingTop &&
        previous.fitScale === fitScale &&
        previous.cardHeight === tallestCard &&
        previous.desktop === desktop
          ? previous
          : { top, headingTop, fitScale, cardHeight: tallestCard, desktop },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (viewport.current) observer.observe(viewport.current);
    if (headingElement.firstElementChild) observer.observe(headingElement.firstElementChild);
    list.querySelectorAll("article > div").forEach((content) => observer.observe(content));
    measure();
    return () => observer.disconnect();
  }, [viewport]);
  const cards = Children.toArray(children);
  const { scrollYProgress } = useScroll({
    container: viewport,
    target: layout.desktop ? section : stack,
    offset: [`start ${layout.desktop ? layout.headingTop : layout.top}px`, "end end"],
  });
  return (
    <div
      ref={section}
      className={styles.section}
      style={
        {
          "--security-stack-top": `${layout.top}px`,
          "--security-heading-top": `${layout.headingTop}px`,
          "--security-card-height": `${layout.cardHeight}px`,
          "--security-heading-reserve": `${layout.cardHeight + (layout.desktop ? 64 : 48) + 64}px`,
        } as CSSProperties
      }
    >
      <div ref={header} className={styles.heading}>
        {heading}
      </div>
      <div ref={stack} role="list" className={`${styles.stack} relative px-1 sm:px-4`}>
        {cards.map((card, index) => (
          <StickyCard_001
            key={index}
            i={index}
            progress={scrollYProgress}
            range={[index / cards.length, 1]}
            fitScale={layout.fitScale}
            targetScale={layout.desktop ? 1 - (cards.length - index - 1) * 0.04 : 1}
          >
            {card}
          </StickyCard_001>
        ))}
      </div>
    </div>
  );
}
