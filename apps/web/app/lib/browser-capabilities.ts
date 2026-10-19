"use client";

import { useSyncExternalStore } from "react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { deviceKeySupported } from "./device-key";

const subscribe = () => () => undefined;
const serverSnapshot = () => false;
const clientSnapshot = () => true;

/** Keep the server and first hydration render identical before checking browser APIs. */
export function useBrowserCapabilities() {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return {
    ready: mounted,
    passkey: mounted && browserSupportsWebAuthn(),
    deviceKey: mounted && deviceKeySupported(),
  };
}
