"use client";
import { useEffect, useState } from "react";
import { createOperationGate } from "./operation-gate";
import type { OperationGate } from "./operation-gate";

/**
 * The page's operation gate (see operation-gate.ts). One per page or flow, stable across renders. It is revived on mount
 * and disposed on unmount, so React Strict Mode's mount-unmount-mount leaves it usable and a real unmount silences it.
 */
export function useOperation(): OperationGate {
  const [gate] = useState(createOperationGate);
  useEffect(() => {
    gate.revive();
    return () => gate.dispose();
  }, [gate]);
  return gate;
}
