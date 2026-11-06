/*
 * Permit2, as the two allowances it actually needs.
 *
 * A Universal Router swap pulls the input through Permit2 rather than directly, so there are two
 * allowances in series and BOTH must exist:
 *
 *   1. ERC-20:  owner -> Permit2,  `approve(spender, amount)`                       selector 0x095ea7b3
 *   2. Permit2: owner -> router,   `approve(token, spender, amount, expiration)`    selector 0x87517c45
 *
 * They are not equivalent and they are not interchangeable. The FIRST is the binding one: Permit2 moves
 * tokens by calling `transferFrom` on the token itself, so it can never move more than the ERC-20
 * allowance granted to it. Verified on Celo mainnet (2026-11-06) by setting the Permit2 allowance to
 * 1,000 cNGN and the ERC-20 allowance to 10, then simulating two swaps: 5 cNGN succeeded and 100 cNGN
 * reverted with TRANSFER_FROM_FAILED, which is the ERC-20 layer refusing, not Permit2.
 *
 * That is what makes this design safe. Kaada keeps allowance 1 bounded to exactly one swap's input, per
 * payment, through the ordinary approval step. Allowance 2 can therefore be granted once, generously,
 * without widening what can ever move: the tighter gate still binds, and it is the one Kaada controls
 * per payment.
 *
 * Allowance 2 is NOT expressible on the payment path, by design. Its four-argument selector is not in
 * ALLOWED_SELECTORS and must not be added: the delegated session key is restricted to approve and
 * transfer, and widening that would weaken every payment to make one provider convenient. It is a
 * one-time grant per token, so it belongs to wallet setup, signed by the ROOT, and that is where it is.
 */

/** Permit2 is deployed at the same address on every chain. */
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

/**
 * The only contracts Kaada will ever ask a wallet's ROOT to grant a Permit2 allowance to, by chain.
 *
 * WHY A FIXED LIST AND NOT "WHATEVER THE PROVIDER SAYS". The grant is signed by the root (a passkey tap the person
 * cannot inspect), lasts for weeks, and is made to `swap.to`, an address that arrives in the provider's API response.
 * Taken on trust, a hostile or compromised response turns one routine confirmation into a standing allowance for an
 * attacker's contract. Reproduced against the adapter on 2026-11-06: a response with `swap.to` set to an arbitrary address
 * produced a READY plan whose root-signed grant named that address.
 *
 * Source: Uniswap's own deployment record, `Uniswap/universal-router/deploy-addresses/celo.json`, key
 * `UniversalRouterV2_1_2`. It is also the address the Trading API returns today, and swaps through it were run on Celo
 * mainnet. If Uniswap deploys a newer router, Kaada refuses it (safely) until an address is added HERE, deliberately.
 */
export const TRUSTED_PERMIT2_SPENDERS: Readonly<Record<number, readonly string[]>> = {
  42220: ["0xe2023f3fa515cf070e07fd9d51c1d236e07843f4"],
};

/** Whether `address` is a contract Kaada has deliberately decided may hold a Permit2 allowance on this chain. */
export function isTrustedPermit2Spender(chainId: number, address: string): boolean {
  return (TRUSTED_PERMIT2_SPENDERS[chainId] ?? []).includes(address.toLowerCase());
}

/**
 * How large and how long a one-time Permit2 grant is.
 *
 * Sized in WHOLE tokens, not raw units: a raw figure means 10^18 whole tokens for a 6-decimal token and 1 million for an
 * 18-decimal one, and the original fixed 10^24 did exactly that without anyone meaning it to. The ERC-20 allowance, which
 * Kaada rebuilds bounded to one swap on every payment, is what actually limits spending; this only decides how often the
 * root has to sign again.
 */
export interface Permit2GrantPolicy {
  wholeTokens: bigint;
  durationSeconds: bigint;
}

/** The raw amount of a grant for a token with `decimals`, never above what Permit2's uint160 can hold. */
export function permit2GrantAmount(policy: Permit2GrantPolicy, decimals: number): bigint {
  const raw = policy.wholeTokens * 10n ** BigInt(decimals);
  return raw > PERMIT2_MAX_AMOUNT ? PERMIT2_MAX_AMOUNT : raw;
}

/** `approve(address token, address spender, uint160 amount, uint48 expiration)` on Permit2. */
export const PERMIT2_APPROVE_SELECTOR = "0x87517c45";

/** The largest `uint160` amount, and the largest `uint48` expiration Permit2 accepts. */
export const PERMIT2_MAX_AMOUNT = (1n << 160n) - 1n;
export const PERMIT2_MAX_EXPIRATION = (1n << 48n) - 1n;

const word = (value: string | bigint): string =>
  (typeof value === "bigint"
    ? value.toString(16)
    : value.replace(/^0x/, "").toLowerCase()
  ).padStart(64, "0");

export interface Permit2Allowance {
  amount: bigint;
  /** Unix seconds. Permit2 treats a past expiration as no allowance at all. */
  expiration: bigint;
}

export interface Permit2ApproveInput {
  token: string;
  /** The contract allowed to pull through Permit2: the Universal Router. */
  spender: string;
  amount: bigint;
  /** Unix seconds. */
  expiration: bigint;
}

/**
 * `Permit2.approve` calldata, built here from validated values and never taken from a provider.
 *
 * Range-checked rather than truncated: `uint160` and `uint48` silently wrap on overflow, and an amount
 * or expiry that wrapped would grant something other than what was asked for.
 */
export function encodePermit2Approve(input: Permit2ApproveInput): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.token))
    throw new Error("permit2 approve: bad token address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.spender)) {
    throw new Error("permit2 approve: bad spender address");
  }
  if (input.amount < 0n || input.amount > PERMIT2_MAX_AMOUNT) {
    throw new Error("permit2 approve: amount does not fit uint160");
  }
  if (input.expiration < 0n || input.expiration > PERMIT2_MAX_EXPIRATION) {
    throw new Error("permit2 approve: expiration does not fit uint48");
  }
  return `${PERMIT2_APPROVE_SELECTOR}${word(input.token)}${word(input.spender)}${word(
    input.amount,
  )}${word(input.expiration)}`;
}

/** Whether an existing Permit2 allowance already covers an amount at a given time. */
export function permit2AllowanceCovers(
  allowance: Permit2Allowance,
  amount: bigint,
  now: Date,
): boolean {
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  return allowance.amount >= amount && allowance.expiration > seconds;
}

/** Reads the Permit2 allowance a wallet has granted a spender for one token. READ ONLY. */
export interface Permit2AllowanceReader {
  readPermit2Allowance(input: {
    chainId: number;
    owner: string;
    token: string;
    spender: string;
  }): Promise<Permit2Allowance>;
}
