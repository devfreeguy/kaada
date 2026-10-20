"use client";

import type { CSSProperties } from "react";
import { useMapContext } from "react-simple-maps";
import { supportedCountries } from "./global-reach-countries";
import styles from "./global-reach-connections.module.css";

// A quiet circuit connects every supported market without drawing a web of all possible routes.
const circuit = ["566", "076", "032", "152", "604", "170", "484", "840", "360", "566"];

export function GlobalReachConnections() {
  const { projection } = useMapContext();
  return (
    <g aria-hidden="true" className={styles.connections}>
      {circuit.slice(0, -1).map((id, index) => {
        const from = supportedCountries.find((country) => country.id === id);
        const to = supportedCountries.find((country) => country.id === circuit[index + 1]);
        if (!from || !to) return null;
        const start = projection(from.coordinates);
        const end = projection(to.coordinates);
        if (!start || !end) return null;
        const [x1, y1] = start;
        const [x2, y2] = end;
        const lift = Math.min(155, Math.max(28, Math.hypot(x2 - x1, y2 - y1) * 0.24));
        const crest = Math.min(y1, y2) - lift;
        const path = `M ${x1} ${y1} C ${x1} ${crest}, ${x2} ${crest}, ${x2} ${y2}`;
        return (
          <g
            key={`${from.id}-${to.id}`}
            className={styles.route}
            style={
              { animationDelay: `${index * 8}s`, "--route-delay": `${index * 8}s` } as CSSProperties
            }
          >
            <path d={path} className={styles.thread} vectorEffect="non-scaling-stroke" />
            <path
              d={path}
              pathLength={1}
              className={styles.pulse}
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={path}
              pathLength={1}
              className={styles.light}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </g>
  );
}
