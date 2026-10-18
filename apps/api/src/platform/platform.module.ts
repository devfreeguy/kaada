import { Global, Logger, Module } from "@nestjs/common";
import { PlatformWallet } from "@kaada/blockchain";
import type { AppConfig } from "@kaada/config";
import { celo } from "viem/chains";

import { APP_CONFIG } from "../config/config.module.js";
import { applicationRoots } from "../security/application-roots.js";
import { PLATFORM_WALLET } from "./platform.tokens.js";

/**
 * Builds the platform wallet at startup, or fails the process. Reads the key FILE, derives its address and compares it with
 * PLATFORM_WALLET_ADDRESS: a mismatch, a missing file or a malformed key stops the API from starting (production never generates a
 * replacement). Only the PUBLIC address is logged. Nothing here is reachable from a controller, and no route returns the wallet.
 */
export function createPlatformWallet(
  config: AppConfig,
  log: (message: string) => void,
): PlatformWallet | null {
  const platform = config.platformWallet;
  if (!platform) return null;
  const wallet = PlatformWallet.load({
    keyFile: platform.keyFile,
    expectedAddress: platform.address,
    repositoryRoot: applicationRoots(),
    chain: celo,
    rpcUrl: config.wallet.rpcUrl,
  });
  log(`platform wallet ${wallet.address}`);
  return wallet;
}

/**
 * Kaada's one platform / agent wallet: the public identity on Celo, the future service-fee recipient and the sender of
 * platform-owned transactions. It is NOT used for user payments (those run through each user's Kernel and session permission).
 */
@Global()
@Module({
  providers: [
    {
      provide: PLATFORM_WALLET,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): PlatformWallet | null => {
        const logger = new Logger("Platform");
        return createPlatformWallet(config, (message) => logger.log(message));
      },
    },
  ],
  exports: [PLATFORM_WALLET],
})
export class PlatformModule {}
