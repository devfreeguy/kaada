import { ZERODEV_PASSKEY_VALIDATOR_CODEHASH } from "@kaada/contracts";
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
} from "viem";
import type { Address, Chain, Hex } from "viem";

/** The addresses (and delay) the API was configured with, to be compared with what is on chain. All public. */
export interface ExpectedRecoveryDeployment {
  validator: string;
  relayer: string;
  minDelaySeconds: number;
  passkeyFactory: string;
  passkeyImplementation: string;
  deviceFactory: string;
  deviceImplementation: string;
}

/** Read-only chain access, so the check can be tried without a network. */
export interface DeploymentReader {
  /** The deployed bytecode, or undefined when there is none. Throws when the chain cannot be reached. */
  getCode(address: Address): Promise<Hex | undefined>;
  /** A call that returns one value. Throws `DefinitiveReadError` when the contract answered (reverted, or nothing there to answer),
   * and anything else when the chain could not be reached. */
  read(address: Address, fn: DeploymentGetter): Promise<string>;
}

export type DeploymentGetter =
  "RELAYER" | "minDelay" | "IMPLEMENTATION" | "IMPLEMENTATION_CODEHASH";

/** The contract itself answered, with a revert or no data: what is deployed is not what was expected. */
export class DeploymentReadError extends Error {}

export type DeploymentCheckResult =
  | { status: "OK" }
  | { status: "MISMATCH"; problems: string[] }
  | { status: "UNAVAILABLE"; reason: string };

const getterAbi = parseAbi([
  "function RELAYER() view returns (address)",
  "function minDelay() view returns (uint32)",
  "function IMPLEMENTATION() view returns (address)",
  "function IMPLEMENTATION_CODEHASH() view returns (bytes32)",
]);

export function createDeploymentReader(options: {
  chain: Chain;
  rpcUrl: string;
}): DeploymentReader {
  const client = createPublicClient({
    chain: options.chain,
    transport: http(options.rpcUrl, { timeout: 10_000, retryCount: 1 }),
  });
  return {
    getCode: (address) => client.getCode({ address }),
    async read(address, fn) {
      try {
        const value: unknown = await client.readContract({
          address,
          abi: getterAbi,
          functionName: fn as "RELAYER",
        });
        return typeof value === "bigint" ? value.toString() : String(value);
      } catch (error) {
        if (
          error instanceof BaseError &&
          error.walk(
            (e) =>
              e instanceof ContractFunctionRevertedError ||
              e instanceof ContractFunctionZeroDataError,
          )
        ) {
          throw new DeploymentReadError(`${fn}() on ${address} did not answer`, { cause: error });
        }
        throw error;
      }
    },
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Compares the deployed contracts with the configuration, read-only. A MISMATCH is definitive and names the value found on chain and
 * the value expected. UNAVAILABLE means the chain could not be read (an RPC outage): nothing is known, so nothing is concluded.
 */
export async function checkRecoveryDeployment(
  reader: DeploymentReader,
  expected: ExpectedRecoveryDeployment,
  passkeyCodehash: Hex = ZERODEV_PASSKEY_VALIDATOR_CODEHASH,
): Promise<DeploymentCheckResult> {
  const problems: string[] = [];
  const note = (label: string, onChain: string, wanted: string) =>
    problems.push(`${label}: on chain ${onChain}, expected ${wanted}`);

  try {
    const compare = async (
      label: string,
      address: string,
      fn: DeploymentGetter,
      wanted: string,
      comparable: (v: string) => string = (v) => v,
    ) => {
      let found: string;
      try {
        found = await reader.read(getAddress(address), fn);
      } catch (error) {
        if (error instanceof DeploymentReadError) {
          problems.push(
            `${label}: ${fn}() on ${address} gave no answer (not the expected contract)`,
          );
          return;
        }
        throw error;
      }
      if (!same(comparable(found), comparable(wanted))) note(label, found, wanted);
    };

    const hasCode = async (label: string, address: string) => {
      const code = await reader.getCode(getAddress(address));
      if (!code || code === "0x") {
        problems.push(`${label}: no contract code at ${address}`);
        return undefined;
      }
      return code;
    };

    if (await hasCode("recovery validator", expected.validator)) {
      await compare(
        "recovery validator RELAYER()",
        expected.validator,
        "RELAYER",
        expected.relayer,
      );
      await compare(
        "recovery validator minDelay()",
        expected.validator,
        "minDelay",
        String(expected.minDelaySeconds),
      );
    }

    const factories: Array<[string, string, string, Hex | undefined]> = [
      ["passkey", expected.passkeyFactory, expected.passkeyImplementation, passkeyCodehash],
      ["device-key", expected.deviceFactory, expected.deviceImplementation, undefined],
    ];
    for (const [name, factory, implementation, pinnedHash] of factories) {
      const implementationCode = await hasCode(`${name} implementation`, implementation);
      const factoryCode = await hasCode(`${name} factory`, factory);
      if (factoryCode) {
        await compare(
          `${name} factory IMPLEMENTATION()`,
          factory,
          "IMPLEMENTATION",
          implementation,
        );
      }
      if (factoryCode && implementationCode) {
        // The passkey implementation is ZeroDev's, pinned by hash. The device-key one is ours: what the factory recorded must be the
        // hash of the code that is actually at the implementation address.
        await compare(
          `${name} factory IMPLEMENTATION_CODEHASH()`,
          factory,
          "IMPLEMENTATION_CODEHASH",
          pinnedHash ?? keccak256(implementationCode),
        );
        if (pinnedHash && !same(keccak256(implementationCode), pinnedHash)) {
          note(`${name} implementation code hash`, keccak256(implementationCode), pinnedHash);
        }
      }
    }
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return problems.length > 0 ? { status: "MISMATCH", problems } : { status: "OK" };
}
