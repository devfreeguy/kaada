"use client";
import { useId } from "react";
import type { ComponentPropsWithoutRef } from "react";

/** A labelled input. The label is always visible: a placeholder is an example, not a name. */
export function TextField({
  label,
  hint,
  mono = false,
  center = false,
  ...input
}: {
  label: string;
  hint?: string;
  /** Codes and keys read better in a fixed-width face. */
  mono?: boolean;
  center?: boolean;
} & Omit<ComponentPropsWithoutRef<"input">, "className" | "id">) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        className={`${mono ? "font-mono tracking-widest" : ""} ${center ? "text-center" : ""}`.trim()}
        {...input}
      />
      {hint ? <p className="text-xs text-app-faint">{hint}</p> : null}
    </div>
  );
}
