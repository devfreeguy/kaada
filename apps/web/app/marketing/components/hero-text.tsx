import type { CSSProperties } from "react";
import styles from "./hero-entrance.module.css";

/** Server-rendered words preserve natural whitespace and need no hydration or font measurements. */
export function HeroText({ text, order = 0 }: { text: string; order?: number }) {
  return text.split(/(\s+)/).map((piece, index) =>
    piece.trim() ? (
      <span
        key={index}
        className={styles.word}
        style={{ "--hero-order": Math.min(8, order + Math.floor(index / 2)) } as CSSProperties}
      >
        {piece}
      </span>
    ) : (
      piece
    ),
  );
}
