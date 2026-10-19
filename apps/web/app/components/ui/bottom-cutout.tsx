type BottomCutoutProps = {
  color?: string;
  className?: string;
};

export function BottomCutout({ color = "var(--background)", className = "" }: BottomCutoutProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 240 100"
      width="240"
      height="100"
      fill={color}
      className={`pointer-events-none absolute -bottom-px left-1/2 z-10 h-auto w-32 -translate-x-1/2 overflow-visible select-none sm:w-44 ${className}`}
    >
      <path d="M-2 100C66 100 120 62 120 0C120 62 174 100 242 100V103H-2Z" />
    </svg>
  );
}
