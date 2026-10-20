"use client";

import { createContext, useContext, useRef, type ReactNode, type RefObject } from "react";
import { ScrollArea } from "./ui/scroll-area";

const PageScrollContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function usePageScrollViewport() {
  const viewport = useContext(PageScrollContext);
  if (!viewport) throw new Error("Page scroll viewport requires PageScrollArea.");
  return viewport;
}

export function PageScrollArea({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  return (
    <PageScrollContext.Provider value={viewport}>
      <ScrollArea
        className="h-dvh"
        viewportRef={viewport}
        viewportProps={{ id: "page-scroll-viewport", tabIndex: 0 }}
      >
        {children}
      </ScrollArea>
    </PageScrollContext.Provider>
  );
}
