"use client";

import { motion, useReducedMotion, useTransform, type MotionValue } from "framer-motion";
import type { ReactNode } from "react";
import styles from "./skiper16.module.css";

/**
 * Adapted from Skiper UI 16 by @gurvinder-singh02: https://skiper-ui.com/v1/skiper16
 * Free version attribution retained. Scroll Area supplies the scroll container;
 * this component does not mount the demo's document-wide Lenis driver.
 */
export function StickyCard_001({
  i,
  progress,
  range,
  targetScale,
  fitScale = 1,
  children,
}: {
  i: number;
  progress: MotionValue<number>;
  range: [number, number];
  targetScale: number;
  fitScale?: number;
  children: ReactNode;
}) {
  const scale = useTransform(progress, range, [fitScale, targetScale * fitScale]);
  const reducedMotion = useReducedMotion();
  return (
    <div className={styles.track} role="listitem">
      <motion.div className={styles.card} style={{ scale: reducedMotion ? 1 : scale, y: i * 12 }}>
        {children}
      </motion.div>
    </div>
  );
}
