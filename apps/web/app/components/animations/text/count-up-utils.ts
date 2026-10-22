import type { CSSProperties } from "react";
import { cubicBezier } from "framer-motion";
import type { CountFormatOptions, RollColumn, RollSlot, RollModel } from "./count-up-types";

export const CELL = 1.2;
export const STAGGER = 0.07;
const UNITS: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];
export const SLOT_STYLE: CSSProperties = {
  display: "inline-block",
  height: `${CELL}em`,
  lineHeight: `${CELL}em`,
};
export const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const smooth = (edge0: number, edge1: number, value: number) => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
export const mod10 = (value: number) => ((value % 10) + 10) % 10;

export const makeSpring = (overshoot: number) => {
  const log = Math.log(Math.min(0.5, Math.max(0.001, overshoot)));
  const zeta = -log / Math.sqrt(Math.PI * Math.PI + log * log);
  const damped = Math.PI / 0.52;
  const natural = damped / Math.sqrt(1 - zeta * zeta);
  const raw = (t: number) =>
    1 -
    Math.exp(-zeta * natural * t) *
      (Math.cos(damped * t) + ((zeta * natural) / damped) * Math.sin(damped * t));
  const residual = 1 - raw(1);
  return (t: number) => (t >= 1 ? 1 : raw(t) + residual * t * t * t);
};

export const EASINGS = {
  linear: (t: number) => t,
  easeOut: cubicBezier(0.33, 1, 0.68, 1),
  expo: (t: number) => (t >= 1 ? 1 : (1 - Math.pow(2, -10 * t)) / (1 - Math.pow(2, -10))),
  spring: makeSpring(0.06),
};

export const getDecimalPlaces = (value: number) => {
  const [coefficient = "", exponent = "0"] = value.toString().toLowerCase().split("e");
  return Math.max(0, (coefficient.split(".")[1]?.length ?? 0) - Number(exponent));
};

const unitFor = (value: number): [number, string] =>
  UNITS.find(([size]) => Math.abs(value) >= size * 0.9995) || [1, ""];

export const scaleFor = (
  value: number,
  compact: boolean,
  decimals: number | undefined,
  places: number,
) => {
  if (!compact) return { size: 1, label: "", digits: places };
  const [size, label] = unitFor(value);
  const digits = decimals ?? (label ? (Math.abs(value) / size < 100 ? 1 : 0) : places);
  return { size, label, digits };
};

export const splitNumber = (value: number, digits: number, size: number) => {
  const fixed = (Math.abs(value) / size).toFixed(digits);
  const [int = "0", frac = ""] = fixed.split(".");
  return { negative: value < 0 && Number(fixed) !== 0, int, frac };
};

export const group = (int: string, separator: string) =>
  separator ? int.replace(/\B(?=(\d{3})+(?!\d))/g, () => separator) : int;

export const buildRoll = (
  a: number,
  b: number,
  spin: boolean,
  { compact, decimals, places, separator }: CountFormatOptions,
): RollModel => {
  const { size, label, digits } = scaleFor(b, compact, decimals, places);
  const pa = splitNumber(a, digits, size);
  const pb = splitNumber(b, digits, size);
  const length = Math.max(pa.int.length, pb.int.length);
  const slots: RollSlot[] = [];
  const columns: RollColumn[] = [];
  if (pa.negative || pb.negative)
    slots.push({ char: "-", enter: !pa.negative, leave: !pb.negative });
  const digitAt = (parts: ReturnType<typeof splitNumber>, place: number) => {
    if (place < 0) return Number(parts.frac[-place - 1]);
    const index = parts.int.length - 1 - place;
    return index >= 0 ? Number(parts.int[index]) : null;
  };
  for (let place = length - 1; place >= -digits; place--) {
    if (place === -1) slots.push({ char: "." });
    const start = digitAt(pa, place);
    const end = digitAt(pb, place);
    const column: RollColumn = {
      delta: 0,
      slot: slots.length,
      index: columns.length,
      place,
      from: start ?? 0,
      to: end ?? 0,
      enter: start === null,
      leave: end === null,
    };
    slots.push(column);
    columns.push(column);
    if (separator && place > 0 && place % 3 === 0)
      slots.push({ char: separator, follow: column.index });
  }
  const up = spin || b >= a;
  columns.forEach((column, index) => {
    const rank = columns.length - 1 - index;
    const base = up ? mod10(column.to - column.from) : -mod10(column.from - column.to);
    const turns = spin
      ? Math.max(1, 3 - rank)
      : Math.min(
          Math.floor(Math.abs(b - a) / (size * 10 ** (column.place + 1))),
          Math.max(0, 3 - rank),
        );
    column.delta = base + (up ? 10 : -10) * turns;
  });
  return { slots, columns, label };
};
