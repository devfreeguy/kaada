"use client";
import { ActionButton } from "../../components/application/action-button";
import { CredentialUnavailable } from "../../components/application/credential-unavailable";
import { VerificationStep } from "../../components/application/verification-step";
import { verifyCopy } from "../../lib/app-copy";
import { useBrowserCapabilities } from "../../lib/browser-capabilities";
import type { useSetup } from "./use-setup";

type Props = Pick<
  ReturnType<typeof useSetup>,
  "view" | "deviceKeysEnabled" | "createWithDevice" | "create"
>;

/**
 * The first screen of setup. It offers only what this browser can do: a passkey when it has WebAuthn, a device key when the
 * server allows one AND this browser can keep one. A person whose browser can do neither is told so, with no action to fail.
 */
export function SetupCredentialStep(props: Props) {
  const capabilities = useBrowserCapabilities();
  return <SetupCredentialView {...props} capabilities={capabilities} />;
}

export function SetupCredentialView({
  view,
  deviceKeysEnabled,
  createWithDevice,
  create,
  capabilities,
}: Props & { capabilities: ReturnType<typeof useBrowserCapabilities> }) {
  const creating = view.name === "creating";
  // Before the browser has been checked, show the default: the check cannot run during the server render.
  const passkey = !capabilities.ready || capabilities.passkey;
  const device = deviceKeysEnabled && (!capabilities.ready || capabilities.deviceKey);
  const notice = view.name === "error" ? view.message : undefined;

  if (!passkey && !device) {
    return (
      <VerificationStep
        context="wallet-setup"
        method="passkey"
        hint=""
        actionHidden
        notice={notice}
        alternative={<CredentialUnavailable />}
      />
    );
  }

  const deviceOnly = !passkey;
  return (
    <VerificationStep
      context="wallet-setup"
      method={deviceOnly ? "device" : "passkey"}
      waiting={creating}
      notice={notice}
      onConfirm={() => void (deviceOnly ? createWithDevice() : create())}
      alternative={
        passkey && device && !creating ? (
          <ActionButton variant="secondary" onClick={() => void createWithDevice()}>
            {verifyCopy("wallet-setup", "device").action}
          </ActionButton>
        ) : null
      }
      footer={<p className="text-xs text-app-faint">Kaada never sees your passkey or key.</p>}
    />
  );
}
