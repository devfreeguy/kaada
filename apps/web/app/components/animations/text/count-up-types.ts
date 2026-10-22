import type { CSSProperties } from "react";

export type CountUpProps = {
  to: number;
  from?: number;
  mode?: "count" | "roll";
  easing?: "easeOut" | "linear" | "expo" | "spring";
  format?: "standard" | "compact";
  decimals?: number;
  direction?: "up" | "down";
  trigger?: "view" | "load";
  replayOnHover?: boolean;
  delay?: number;
  duration?: number;
  className?: string;
  style?: CSSProperties;
  startWhen?: boolean;
  separator?: string;
  prefix?: string;
  suffix?: string;
  onStart?: () => void;
  onEnd?: () => void;
};
export type CountUpPlay = { id: number; from: number; to: number; spin: boolean; wait?: boolean };
export type RollColumn = {
  char?: never;
  follow?: never;
  slot: number;
  index: number;
  place: number;
  from: number;
  to: number;
  enter: boolean;
  leave: boolean;
  delta: number;
};
export type RollMark = { char: string; enter?: boolean; leave?: boolean; follow?: number };
export type RollSlot = RollColumn | RollMark;
export type RollModel = { slots: RollSlot[]; columns: RollColumn[]; label: string };
export type CountFormatOptions = {
  compact: boolean;
  decimals: number | undefined;
  places: number;
  separator: string;
};
export type CountUpLive = {
  formatValue: (value: number) => string;
  onStart: (() => void) | undefined;
  onEnd: (() => void) | undefined;
  model: RollModel | null;
  mode: "count" | "roll";
  easing: NonNullable<CountUpProps["easing"]>;
  duration: number;
  delay: number;
};
