import type { CSSProperties } from "react";
import styles from "./particle.module.css";

export type ParticleProps = {
  color?: string;
  borderColor?: string;
  size?: number | string;
  borderWidth?: number;
  animation?: "none" | "spin" | "horizontal" | "vertical";
  duration?: number;
  delay?: number;
  distance?: number;
  rotation?: number;
  className?: string;
};

type Shape = "star" | "plus" | "crown" | "sparkle";

const paths: Record<Shape, string> = {
  star: "M12 2.6 C12.7 2.6 13.3 3 13.6 3.7 L15 6.6 C15.2 7 15.6 7.3 16 7.4 L19.2 7.9 C20.3 8.1 20.8 9.4 20 10.2 L17.7 12.4 C17.4 12.8 17.2 13.3 17.3 13.8 L17.8 16.9 C18 18 16.9 18.8 15.9 18.3 L13 16.8 C12.4 16.5 11.6 16.5 11 16.8 L8.1 18.3 C7.1 18.8 6 18 6.2 16.9 L6.7 13.8 C6.8 13.3 6.6 12.8 6.3 12.4 L4 10.2 C3.2 9.4 3.7 8.1 4.8 7.9 L8 7.4 C8.4 7.3 8.8 7 9 6.6 L10.4 3.7 C10.7 3 11.3 2.6 12 2.6Z",
  plus: "M400 160h-80V80a80 80 0 0 0-160 0v80H80a80 80 0 0 0 0 160h80v80a80 80 0 0 0 160 0v-80h80a80 80 0 0 0 0-160Z",
  crown:
    "M12 23C7 19 5 23 7 29L13 48Q14 53 19 53H45Q50 53 51 48L57 29C59 23 57 19 52 23L42 31 37 18C35 10 29 10 27 18L22 31Z",
  sparkle:
    "M208 40h64v123.4l87.3-87.3 45.3 45.3-87.3 87.3H440v64H317.3l87.3 87.3-45.3 45.3-87.3-87.3V440h-64V317.3l-87.3 87.3-45.3-45.3 87.3-87.3H40v-64h122.7l-87.3-87.3 45.3-45.3 87.3 87.3V40Z",
};

export function Particle({
  shape = "star",
  color = "var(--primary)",
  borderColor = "var(--navy)",
  size = 40,
  borderWidth = 5,
  animation = "none",
  duration = 48,
  delay = 0,
  distance = 6,
  rotation = 0,
  className = "",
}: ParticleProps & { shape?: Shape }) {
  const viewBoxSize = shape === "star" ? 24 : shape === "plus" || shape === "sparkle" ? 480 : 64;
  const style = {
    width: size,
    height: size,
    transform: `rotate(${rotation}deg)`,
    "--particle-duration": `${Math.max(duration, 1)}s`,
    "--particle-delay": `${delay}s`,
    "--particle-distance": `${distance}px`,
  } as CSSProperties;

  return (
    <span aria-hidden="true" className={`${styles.particle} ${className}`} style={style}>
      <svg
        viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
        fill={color}
        stroke={borderColor}
        strokeWidth={borderWidth * (viewBoxSize / 64)}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={styles[animation]}
        focusable="false"
      >
        {shape === "sparkle" ? (
          <>
            <path d={paths[shape]} strokeWidth={borderWidth * (viewBoxSize / 64) + 24} />
            <path d={paths[shape]} stroke={color} strokeWidth={24} />
          </>
        ) : (
          <path d={paths[shape]} />
        )}
      </svg>
    </span>
  );
}

export function StarParticle(props: ParticleProps) {
  return <Particle shape="star" {...props} />;
}

export function PlusParticle(props: ParticleProps) {
  return <Particle shape="plus" {...props} />;
}

export function CrownParticle(props: ParticleProps) {
  return <Particle shape="crown" {...props} />;
}

export function SparkleParticle(props: ParticleProps) {
  return <Particle shape="sparkle" {...props} />;
}
