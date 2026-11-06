import { decodeAbiParameters, decodeFunctionData, parseAbi } from "viem";
import type { Hex } from "viem";

/*
 * Reading the Universal Router calldata Uniswap returns, and checking it does what the person was promised.
 *
 * The calldata is what actually executes; the JSON beside it is only a description. So Kaada does not take the JSON's
 * word for what a swap will do: it decodes the bytes and compares them with the request. A swap is only accepted if
 * its calldata says, in its own fields, that:
 *
 *   - the output goes to the wallet (not to some other address);
 *   - exactly the amount the person authorised is spent;
 *   - the input is paid by the wallet, through the allowance Kaada granted;
 *   - the route starts at the token being sold and ends at the token being bought;
 *   - and a minimum output is set, within a hair of the slippage the person agreed to.
 *
 * Reproduced on 2026-11-06 before this existed: a response whose calldata sent the output to an attacker, or set the
 * minimum output to 1, or spent ten times the authorised amount, was accepted as a valid firm quote, because only the
 * command NAMES and the deadline were being read.
 *
 * This module decodes and checks. It never builds swap calldata and never signs.
 */

/** `execute(bytes commands, bytes[] inputs, uint256 deadline)` on the Universal Router. */
export const UNIVERSAL_ROUTER_EXECUTE_SELECTOR = "0x3593564c";

const EXECUTE_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);

/**
 * Router commands Kaada will execute, by byte: ONLY those whose inputs it can fully decode and verify.
 *
 * That is two exact-input pool swaps. Everything else is refused, each for its own reason:
 *  - V4_SWAP (0x10) and the exact-OUTPUT swaps (0x01, 0x09) carry inputs this module does not yet decode, so their
 *    recipient and amounts could not be checked. Exact-output is not offered at all (see the capability seed);
 *  - PERMIT2_PERMIT (0x0a) would carry an EIP-712 signature Kaada does not produce;
 *  - SWEEP / TRANSFER / PAY_PORTION (0x04 / 0x05 / 0x06) move tokens to an address chosen inside the provider's call,
 *    whereas the payout is Kaada's own transfer leg;
 *  - WRAP_ETH / UNWRAP_WETH (0x0b / 0x0c) involve native value, and every Kaada swap carries value 0.
 */
export const ALLOWED_ROUTER_COMMANDS: Record<string, string> = {
  "00": "V3_SWAP_EXACT_IN",
  "08": "V2_SWAP_EXACT_IN",
};

/**
 * The pool versions Kaada asks Uniswap to route through: exactly those whose swap commands are decoded above.
 * Requested on EVERY quote, indicative and firm, so the price the person is shown and the calldata that executes are
 * built from the same set of pools and the two cannot disagree about the route.
 */
export const VERIFIED_PROTOCOLS = ["V2", "V3"] as const;

/** Set on a command byte to mean "a revert of this command does not revert the transaction". */
const ALLOW_REVERT_FLAG = 0x80;

/** The Universal Router's own sentinel for "whoever called execute", which for Kaada is the wallet itself. */
const MSG_SENDER = "0x0000000000000000000000000000000000000001";

const V3_INPUT = [
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "bytes" },
  { type: "bool" },
] as const;
const V2_INPUT = [
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "address[]" },
  { type: "bool" },
] as const;

/** One decoded exact-input pool swap. Addresses are lowercase. */
export interface DecodedSwap {
  command: "V3_SWAP_EXACT_IN" | "V2_SWAP_EXACT_IN";
  recipient: string;
  amountIn: bigint;
  amountOutMin: bigint;
  /** True when the swap is paid by the caller (the wallet), through Permit2. */
  payerIsUser: boolean;
  /** Every token on the route, first to last. */
  tokens: string[];
}

export interface RouterCall {
  /** The command bytes, lowercase hex without a 0x prefix. */
  commands: string;
  /** Their names, in order. */
  commandNames: string[];
  /** The on-chain deadline: past it the router reverts. */
  deadline: Date;
  /** Every swap in the call, decoded. Never empty: a call with no swap is refused. */
  swaps: DecodedSwap[];
}

export type RouterCallProblem =
  | "NOT_ROUTER_EXECUTE"
  | "MALFORMED_CALLDATA"
  | "NO_COMMANDS"
  | "COMMAND_NOT_ALLOWED"
  | "COMMAND_MAY_REVERT_SILENTLY"
  | "SWAP_INPUT_MALFORMED"
  | "NO_DEADLINE";

export type RouterCallResult =
  { ok: true; call: RouterCall } | { ok: false; problem: RouterCallProblem; detail?: string };

/** A V3 path is token (20 bytes), then repeated fee (3 bytes) + token (20 bytes). */
function v3PathTokens(path: Hex): string[] | undefined {
  const bytes = (path.length - 2) / 2;
  if (bytes < 43 || (bytes - 20) % 23 !== 0) return undefined;
  const tokens: string[] = [];
  for (let at = 0; at + 20 <= bytes; at += 23) {
    tokens.push(`0x${path.slice(2 + at * 2, 2 + (at + 20) * 2)}`.toLowerCase());
  }
  return tokens;
}

/**
 * Decodes the router call and refuses anything Kaada is not prepared to execute. Decoding is done by viem's ABI decoder,
 * which checks every offset and length against the data it was given, so a truncated, padded or self-referential
 * response is a refusal rather than a misread.
 */
export function readRouterCall(data: string): RouterCallResult {
  if (!/^0x[0-9a-f]*$/i.test(data)) return { ok: false, problem: "MALFORMED_CALLDATA" };
  const lower = data.toLowerCase() as Hex;
  if (!lower.startsWith(UNIVERSAL_ROUTER_EXECUTE_SELECTOR)) {
    return { ok: false, problem: "NOT_ROUTER_EXECUTE", detail: lower.slice(0, 10) };
  }

  let commandsHex: Hex;
  let inputs: readonly Hex[];
  let deadlineSeconds: bigint;
  try {
    const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: lower });
    [commandsHex, inputs, deadlineSeconds] = decoded.args;
  } catch {
    return { ok: false, problem: "MALFORMED_CALLDATA" };
  }

  const bytes = commandsHex.slice(2).match(/../g) ?? [];
  if (bytes.length === 0) return { ok: false, problem: "NO_COMMANDS" };
  if (inputs.length !== bytes.length) return { ok: false, problem: "MALFORMED_CALLDATA" };

  const commandNames: string[] = [];
  const swaps: DecodedSwap[] = [];
  for (const [index, byte] of bytes.entries()) {
    // A command allowed to fail silently could leave the swap undone while the transaction succeeds, which is the
    // one outcome that must never reach settlement as a success.
    if ((Number.parseInt(byte, 16) & ALLOW_REVERT_FLAG) !== 0) {
      return { ok: false, problem: "COMMAND_MAY_REVERT_SILENTLY", detail: byte };
    }
    const name = ALLOWED_ROUTER_COMMANDS[byte];
    if (!name) return { ok: false, problem: "COMMAND_NOT_ALLOWED", detail: byte };
    commandNames.push(name);

    const input = inputs[index];
    if (input === undefined) return { ok: false, problem: "MALFORMED_CALLDATA" };
    try {
      if (byte === "00") {
        const [recipient, amountIn, amountOutMin, path, payerIsUser] = decodeAbiParameters(
          V3_INPUT,
          input,
        );
        const tokens = v3PathTokens(path);
        if (!tokens) return { ok: false, problem: "SWAP_INPUT_MALFORMED", detail: "v3_path" };
        swaps.push({
          command: "V3_SWAP_EXACT_IN",
          recipient: recipient.toLowerCase(),
          amountIn,
          amountOutMin,
          payerIsUser,
          tokens,
        });
      } else {
        const [recipient, amountIn, amountOutMin, path, payerIsUser] = decodeAbiParameters(
          V2_INPUT,
          input,
        );
        if (path.length < 2)
          return { ok: false, problem: "SWAP_INPUT_MALFORMED", detail: "v2_path" };
        swaps.push({
          command: "V2_SWAP_EXACT_IN",
          recipient: recipient.toLowerCase(),
          amountIn,
          amountOutMin,
          payerIsUser,
          tokens: path.map((token) => token.toLowerCase()),
        });
      }
    } catch {
      return { ok: false, problem: "SWAP_INPUT_MALFORMED", detail: byte };
    }
  }

  if (deadlineSeconds === 0n) return { ok: false, problem: "NO_DEADLINE" };
  // A Date cannot hold more than this many milliseconds; a deadline that far out is not a real one.
  if (deadlineSeconds > 8_640_000_000_000n) return { ok: false, problem: "NO_DEADLINE" };

  return {
    ok: true,
    call: {
      commands: bytes.join(""),
      commandNames,
      deadline: new Date(Number(deadlineSeconds) * 1000),
      swaps,
    },
  };
}

/** What the person was promised, to check the calldata against. */
export interface SwapExpectation {
  /** The wallet that signs and receives the output. */
  taker: string;
  sellToken: string;
  buyToken: string;
  /** Exactly what is authorised to be spent, in the sell token's smallest unit. */
  exactIn: bigint;
  /** What the quote says will come out, in the buy token's smallest unit. */
  outputAmount: bigint;
  /** The slippage Kaada asked for, in basis points. */
  slippageBps: number;
}

/**
 * Why the calldata does not do what was promised, or undefined when it does.
 *
 * The minimum-output floor allows ONE extra basis point below the requested slippage. Uniswap computes its floor with
 * its own rounding and was observed 2 wei under plain arithmetic on a 119-token output; a hair of tolerance accepts that
 * while still refusing a missing floor, which is what matters: a minimum of 1 means no protection at all.
 */
export function checkSwapAgainst(call: RouterCall, expected: SwapExpectation): string | undefined {
  const taker = expected.taker.toLowerCase();
  const sell = expected.sellToken.toLowerCase();
  const buy = expected.buyToken.toLowerCase();

  let spent = 0n;
  let floor = 0n;
  for (const swap of call.swaps) {
    if (swap.recipient !== taker && swap.recipient !== MSG_SENDER) return "swap_recipient_differs";
    if (!swap.payerIsUser) return "swap_payer_not_the_wallet";
    if (swap.tokens[0] !== sell || swap.tokens[swap.tokens.length - 1] !== buy) {
      return "swap_route_differs";
    }
    spent += swap.amountIn;
    floor += swap.amountOutMin;
  }
  if (spent !== expected.exactIn) return "swap_amount_in_differs";

  const looseBps = BigInt(Math.max(0, 10_000 - expected.slippageBps - 1));
  if (floor < (expected.outputAmount * looseBps) / 10_000n) return "swap_min_output_too_low";
  return undefined;
}
