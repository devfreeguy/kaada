import { qrMatrix } from "../lib/qr";

/**
 * Draws `value` as a QR code (an SVG of dark squares on white, with the quiet zone the standard asks for). Drawn from the module
 * matrix, never from an HTML string, and computed in the browser: `value` can be a secret and is not sent anywhere.
 */
export function QrCode({
  value,
  label,
  size = 208,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const matrix = qrMatrix(value);
  const quiet = 4;
  const count = matrix.length + quiet * 2;
  const dark: string[] = [];
  matrix.forEach((row, y) =>
    row.forEach((isDark, x) => {
      if (isDark) dark.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }),
  );
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
      className="self-center rounded-lg bg-white"
    >
      <rect width={count} height={count} fill="#ffffff" />
      <path d={dark.join("")} fill="#000000" />
    </svg>
  );
}
