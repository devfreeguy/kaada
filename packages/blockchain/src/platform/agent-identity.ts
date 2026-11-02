import { getAddress, parseAbi } from "viem";
import type { Address } from "viem";

/*
 * The facts and the hard limits of register-agent-identity.ts, the operator script that registers the platform wallet as an
 * ERC-8004 agent. They live here, apart from the script, so a test can pin each one without a key, a node or a network.
 */

/**
 * The ERC-8004 Identity Registry on Celo mainnet (chain 42220). Sources, which agree with each other and with the chain
 * (the script also checks the address has code and answers `name()` with "AgentIdentity"):
 *   https://docs.celo.org/build-on-celo/build-with-ai/8004
 *   https://github.com/erc-8004/erc-8004-contracts
 */
export const IDENTITY_REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REGISTRY_CHAIN_ID = 42220;

/** Where the website serves Kaada's registration file. `www`, because the bare domain answers with a redirect. */
export const DEFAULT_AGENT_URI = "https://www.kaada.xyz/.well-known/agent-registration.json";

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** The most the script may spend on gas, worst case. The registration must cost STRICTLY less. 0.1 CELO. */
export const MAX_COST_WEI = 100_000_000_000_000_000n;

const MAX_FILE_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export const identityRegistryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function name() view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export interface RegistrationPlan {
  /** ERC-721 balance of the wallet in the registry: how many identities it already owns. */
  owned: bigint;
  gas: bigint;
  /** The most the transaction may pay per gas (EIP-1559 maxFeePerGas), so `gas * maxFeePerGas` bounds the cost. */
  maxFeePerGas: bigint;
  balance: bigint;
  wallet: Address;
}

export function registrationCostWei(plan: Pick<RegistrationPlan, "gas" | "maxFeePerGas">): bigint {
  return plan.gas * plan.maxFeePerGas;
}

/** Throws, in words an operator can act on, unless this wallet owns no identity yet and the registration is cheap and affordable. */
export function assertRegistrationLimits(plan: RegistrationPlan): void {
  if (plan.owned > 0n)
    throw new Error(
      `refusing: ${plan.wallet} already owns ${plan.owned} identity(ies) in the registry; it is never registered twice`,
    );
  const cost = registrationCostWei(plan);
  if (cost >= MAX_COST_WEI)
    throw new Error(
      `refusing: the worst-case gas cost ${cost} wei is not under ${MAX_COST_WEI} wei (0.1 CELO)`,
    );
  if (plan.balance < cost)
    throw new Error(
      `the wallet's balance ${plan.balance} wei cannot pay the worst-case gas cost ${cost} wei: fund ${plan.wallet} first`,
    );
}

/**
 * Runs a read until it answers, up to `attempts` times with `waitMs` between them, and returns `undefined` if it never does. A node
 * that has not caught up with the block of a transaction that already succeeded can fail a read; that is not a failure of the
 * transaction, so the caller reports it instead of aborting. `sleep` is replaceable for tests.
 */
export async function readWithRetry<T>(
  read: () => Promise<T>,
  attempts = 5,
  waitMs = 2_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<T | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await read();
    } catch {
      if (attempt < attempts) await sleep(waitMs);
    }
  }
  return undefined;
}

export interface RegistrationFile {
  type: string;
  name: string;
  description: string;
  services: { name: string; endpoint: string }[];
  registrations: unknown[];
}

/**
 * Fetches the URI NOW and proves it is Kaada's registration file: HTTPS, no redirect (the stored URI must resolve by itself), a 200,
 * a small JSON document of the registration-v1 type, with a name and a description, and listing `wallet` as a service endpoint
 * `eip155:42220:<address>`. Throws otherwise. `fetchFn` is replaceable for tests.
 */
export async function fetchRegistrationFile(
  uri: string,
  wallet: Address,
  fetchFn: typeof fetch = fetch,
): Promise<RegistrationFile> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`refusing: the URI is not a valid URL: ${uri}`);
  }
  if (url.protocol !== "https:") throw new Error("refusing: the URI must be HTTPS");
  if (url.username || url.password) throw new Error("refusing: the URI must not carry credentials");

  let response: Response;
  try {
    response = await fetchFn(url, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`refusing: the URI could not be fetched over HTTPS right now (${reason})`);
  }
  if (response.status !== 200)
    throw new Error(`refusing: the URI answered HTTP ${response.status}, not 200`);
  const text = await response.text();
  if (text.length > MAX_FILE_BYTES) throw new Error("refusing: the registration file is too large");

  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("refusing: the URI does not return JSON");
  }
  const f = file as Partial<RegistrationFile> | null;
  if (typeof f !== "object" || f === null || f.type !== REGISTRATION_TYPE)
    throw new Error(`refusing: the file's type is not ${REGISTRATION_TYPE}`);
  if (typeof f.name !== "string" || f.name.trim() === "")
    throw new Error("refusing: the file has no name");
  if (typeof f.description !== "string" || f.description.trim() === "")
    throw new Error("refusing: the file has no description");
  if (!Array.isArray(f.services) || !Array.isArray(f.registrations))
    throw new Error("refusing: the file needs a services array and a registrations array");
  const walletEndpoint = `eip155:${REGISTRY_CHAIN_ID}:${getAddress(wallet)}`.toLowerCase();
  const lists = f.services.some(
    (service) =>
      service?.name === "wallet" &&
      typeof service.endpoint === "string" &&
      service.endpoint.toLowerCase() === walletEndpoint,
  );
  if (!lists)
    throw new Error(`refusing: the file does not list the wallet as a service (${walletEndpoint})`);
  return f as RegistrationFile;
}
