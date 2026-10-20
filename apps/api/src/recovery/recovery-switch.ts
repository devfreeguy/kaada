import { Global, Module } from "@nestjs/common";

export const RECOVERY_SWITCH = Symbol("RECOVERY_SWITCH");

/**
 * Turns recovery and device-key wallets off while the server runs. It is flipped when the deployed contracts are found NOT to be the
 * configured ones after startup; their endpoints then answer 503 instead of sending money-affecting transactions at the wrong
 * addresses. There is no way back short of a restart, which re-checks the chain.
 */
export class RecoverySwitch {
  private reason: string | null = null;

  get off(): boolean {
    return this.reason !== null;
  }

  disable(reason: string): void {
    this.reason ??= reason;
  }

  get disabledReason(): string | null {
    return this.reason;
  }
}

@Global()
@Module({
  providers: [{ provide: RECOVERY_SWITCH, useValue: new RecoverySwitch() }],
  exports: [RECOVERY_SWITCH],
})
export class RecoverySwitchModule {}
