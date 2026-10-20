import type { AppConfig } from "@kaada/config";

/**
 * What this instance is configured to do, with no secret in it: the fields of the `app.started` line. A web page that cannot reach
 * or verify against this API is almost always a mismatch between these values and the web host's, and whether recovery and device
 * keys are on (and for which network) is the first thing to read when a recovery route answers 503.
 */
export function startedFields(config: AppConfig) {
  const passkey = config.wallet.passkey;
  return {
    event: "app.started",
    nodeEnv: config.nodeEnv,
    listening: `${config.apiHost}:${String(config.port)}`,
    webUrl: config.webUrl,
    corsOrigins: config.corsOrigins,
    passkeyRpId: passkey?.rpId ?? null,
    passkeyOrigin: passkey?.origin ?? null,
    walletProvider: config.wallet.provider,
    executionEnabled: config.execution.enabled,
    recoveryEnabled: config.recovery.enabled,
    recoveryNetwork: config.recovery.network,
    deviceKeyRootsEnabled: config.wallet.deviceKeyRoots !== undefined,
  };
}
