import type { ReactNode } from "react";
import type { MotionStyle } from "framer-motion";

export type ComponentTransitionProps = {
  children: ReactNode;
  className?: string;
  style?: MotionStyle;
  id?: string;
  /** Toggle this prop to animate removal. Keep the transition wrapper mounted. */
  visible?: boolean;
  trigger?: "mount" | "in-view";
  /** Reveal once by default; false also animates out when leaving the Scroll Area. */
  once?: boolean;
  duration?: number;
  delay?: number;
  exitDuration?: number;
  amount?: number | "some" | "all";
  margin?: `${number}px ${number}px ${number}px ${number}px`;
  /** Clip the entrance, then release overflow so menus and focus rings remain usable. */
  clipEntrance?: boolean;
};

export type SlideTransitionProps = ComponentTransitionProps & {
  /** up: enter from below and exit above; down: enter from above and exit below. */
  direction?: "up" | "down";
  distance?: number;
};

export type PopTransitionProps = ComponentTransitionProps & {
  fromScale?: number;
};
