"use client";

import { Children, useRef, type ReactNode } from "react";
import { useScroll } from "framer-motion";
import { StickyCard_001 } from "@/components/ui/skiper-ui/skiper16";
import { ScrollArea } from "../../components/ui/scroll-area";
import styles from "./security-stack.module.css";

export function SecurityStack({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const cards = Children.toArray(children);
  const { scrollYProgress } = useScroll({
    container: viewport,
    target: stack,
    offset: ["start start", "end end"],
  });
  return (
    <div className="mt-10 sm:mt-14">
      <ScrollArea
        className={styles.scrollArea}
        viewportRef={viewport}
        viewportProps={{
          role: "region",
          "aria-label": "Account protections",
          tabIndex: 0,
        }}
      >
        <div ref={stack} role="list" className="relative px-1 sm:px-4">
          {cards.map((card, index) => (
            <StickyCard_001
              key={index}
              i={index}
              progress={scrollYProgress}
              range={[index / cards.length, 1]}
              targetScale={1 - (cards.length - index - 1) * 0.04}
            >
              {card}
            </StickyCard_001>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
