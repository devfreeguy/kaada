"use client";

import { createContext } from "react";

/** Descendants follow the container's reveal rather than waiting for their own observer. */
export const RevealContext = createContext<{ active: boolean; delay: number } | null>(null);
