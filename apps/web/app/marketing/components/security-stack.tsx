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
  const [layout, setLayout] = useState({ top: 16, headingTop: 48, fitScale: 1 });
  useLayoutEffect(() => {
    const root = section.current;
    const headingElement = header.current;
    const list = stack.current;
    if (!root || !headingElement || !list) return;
    const measure = () => {
      const scroller = viewport.current;
      if (!scroller) return;
      const tallestCard = Math.max(
        ...Array.from(list.querySelectorAll("article"), (card) => card.offsetHeight),
      );
      const headingHeight = headingElement.offsetHeight;
      const height = scroller.clientHeight;
      const headingTop = scroller.clientWidth >= 1024 ? 96 : 48;
      const gap = scroller.clientWidth >= 1024 ? 40 : 24;
      const top = headingTop + headingHeight + gap;
      const fitScale = Math.min(1, Math.max(0.1, (height - top - 60) / tallestCard));
      setLayout((previous) =>
        previous.top === top && previous.headingTop === headingTop && previous.fitScale === fitScale
          ? previous
          : { top, headingTop, fitScale },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (viewport.current) observer.observe(viewport.current);
    observer.observe(headingElement);
    list.querySelectorAll("article").forEach((card) => observer.observe(card));
    measure();
    return () => observer.disconnect();
  }, [viewport]);
  const cards = Children.toArray(children);
  const { scrollYProgress } = useScroll({
    container: viewport,
    target: section,
    offset: [`start ${layout.headingTop}px`, "end end"],
  });
  return (
    <div
      ref={section}
      className={styles.section}
      style={
        {
          "--security-stack-top": `${layout.top}px`,
          "--security-heading-top": `${layout.headingTop}px`,
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
            targetScale={1 - (cards.length - index - 1) * 0.04}
          >
            {card}
          </StickyCard_001>
        ))}
      </div>
    </div>
  );
}
