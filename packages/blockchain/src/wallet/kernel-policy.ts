import type {
  Enforcement,
  PermissionConstraint,
  PermissionPlan,
  PermissionRequest,
  WalletPolicyAdapter,
} from "@kaada/domain";

/** The wallet stack this adapter describes. Pinned: Kernel v3.3 on EntryPoint v0.7. */
export const KERNEL_PROVIDER = "zerodev-kernel-v3.3";

/**
 * What a ZeroDev Kernel v3.3 permission can enforce ON CHAIN (see docs/wallet-architecture.md, verified
 * against the policy contracts deployed on Celo): the call policy (target contracts, function selectors,
 * per-argument conditions, value limit) and the timestamp policy (validity window). There is no
 * on-chain policy that sums spend over time, so a cumulative limit is only a check in Kaada's own code.
 *
 * The map is deliberately conservative and explicit: nothing here is labelled ONCHAIN unless a policy
 * contract the account calls during validation can reject the violating operation.
 */
export const KERNEL_ENFORCEMENT: Readonly<Record<PermissionConstraint, Enforcement>> = {
  contracts: "ONCHAIN",
  operations: "ONCHAIN", // function selectors in the call policy
  assets: "ONCHAIN", // an asset is a token contract the call policy allows
  perTransactionLimit: "ONCHAIN", // an argument condition (for example the approve amount)
  cumulativeLimit: "KAADA_POLICY",
  validity: "ONCHAIN", // timestamp policy
};

export class KernelPolicyAdapter implements WalletPolicyAdapter {
  readonly provider = KERNEL_PROVIDER;

  /** Pure: reports what would be enforced where. It creates no key and installs nothing. */
  plan(_request: PermissionRequest): PermissionPlan {
    return {
      provider: this.provider,
      enforcement: { ...KERNEL_ENFORCEMENT },
      unsupported: [],
    };
  }
}
