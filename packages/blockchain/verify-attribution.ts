/*
 * OPERATOR TOOL (not part of the application: nothing imports it). READ-ONLY: no keys, no database, no sending. Fetches each
 * transaction over Celo RPC and reports whether it succeeded and whether it carries Kaada's ERC-8021 attribution tag.
 *
 *   tsx verify-attribution.ts <txHash> [<txHash> ...]
 *
 * CELO_RPC_URL overrides the public Forno endpoint. For an EntryPoint `handleOps` transaction it also decodes the UserOperations
 * and reports whether the tag ends their inner callData (the tag Kaada's Kernel adapter writes), as against the end of the outer
 * transaction input (where ERC-8021 indexers look).
 */
import { createPublicClient, decodeFunctionData, http, isHash } from "viem";
import type { Hex } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { celo } from "viem/chains";

import { attributionSuffix, CELO_ATTRIBUTION_CODE } from "./src/attribution.js";

const hashes = process.argv.slice(2);
if (hashes.length === 0 || !hashes.every((h) => isHash(h))) {
  console.error("usage: tsx verify-attribution.ts <txHash> [<txHash> ...]  (each a 0x-prefixed 32-byte hash)");
  process.exit(2);
}

const client = createPublicClient({ chain: celo, transport: http(process.env["CELO_RPC_URL"] ?? "https://forno.celo.org") });
const suffix = attributionSuffix().toLowerCase();
const tagHex = suffix.slice(0, 2 + CELO_ATTRIBUTION_CODE.length * 2); // the code's ASCII bytes alone
const yn = (b: boolean): string => (b ? "yes" : "no");

/** Per UserOperation of a handleOps input: does its callData end with the tag. Empty when the input is not handleOps. */
function innerEnds(input: Hex): boolean[] {
  try {
    const { functionName, args } = decodeFunctionData({ abi: entryPoint07Abi, data: input });
    if (functionName !== "handleOps") return [];
    return args[0].map((op) => op.callData.toLowerCase().endsWith(suffix.slice(2)));
  } catch {
    return [];
  }
}

/** Forno is load-balanced and a lagging node can miss a receipt another node has, so a miss is retried before it is believed. */
async function receiptOf(hash: Hex, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) return receipt;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  return null;
}

const rows: Record<string, string>[] = [];
for (const hash of hashes as Hex[]) {
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }).catch(() => null), receiptOf(hash)]);
  if (!tx) {
    rows.push({ hash, receipt: "NOT FOUND" });
    continue;
  }
  const input = tx.input.toLowerCase();
  const inner = innerEnds(tx.input);
  rows.push({
    hash,
    receipt: receipt
      ? `${receipt.status === "success" ? "yes" : "no"} (block ${receipt.blockNumber})`
      : tx.blockNumber === null
        ? "pending"
        : `NO RECEIPT FROM RPC (tx is in block ${tx.blockNumber})`,
    "tag anywhere": yn(input.includes(tagHex.slice(2))),
    "tag at end of input": yn(input.endsWith(suffix.slice(2))),
    "inner callData ends with tag": inner.length === 0 ? "n/a" : inner.map(yn).join(","),
    to: tx.to ?? "(contract creation)",
  });
}
console.table(rows);
