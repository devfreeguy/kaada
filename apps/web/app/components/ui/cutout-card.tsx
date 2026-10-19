import type { ComponentPropsWithoutRef } from "react";

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

type CornerCutoutProps = {
  corner?: Corner;
  color?: string;
  size?: number | string;
  offset?: number | string;
};

/** Place inside a positioned surface; color matches the surrounding background. */
export function CornerCutout({
  corner = "top-right",
  color = "var(--navy)",
  size = 38,
  offset = "24%",
}: CornerCutoutProps) {
  const top = corner.startsWith("top");
  const right = corner.endsWith("right");
  const transform = top
    ? right
      ? undefined
      : "scaleX(-1)"
    : right
      ? "scaleY(-1)"
      : "rotate(180deg)";

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 44 32"
      width="44"
      height="32"
      fill={color}
      className="pointer-events-none absolute z-10 overflow-visible select-none"
      style={{
        [top ? "top" : "bottom"]: 0,
        [right ? "right" : "left"]: offset,
        width: size,
        height: "auto",
        transform,
      }}
    >
      {/* Bleed past the surface edge to cover subpixel anti-aliasing seams. */}
      <path d="M0 -2H44V0C28 0 25 12 28 32L0 0Z" />
    </svg>
  );
}

type CutoutCardProps = ComponentPropsWithoutRef<"div"> & {
  color?: string;
  cutoutColor?: string;
  cutoutSize?: number | string;
};

export function CutoutCard({
  color = "var(--emerald)",
  cutoutColor = "var(--navy)",
  cutoutSize = 38,
  className = "",
  style,
  children,
  ...props
}: CutoutCardProps) {
  return (
    <div
      className={`relative isolate overflow-hidden rounded-[26px] text-navy ${className}`}
      style={{ backgroundColor: color, ...style }}
      {...props}
    >
      <CornerCutout color={cutoutColor} size={cutoutSize} />
      <CornerCutout corner="bottom-left" color={cutoutColor} size={cutoutSize} />
      {children}
    </div>
  );
}
