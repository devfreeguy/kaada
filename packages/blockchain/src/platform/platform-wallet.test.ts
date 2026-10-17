import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { custom, keccak256, parseTransaction } from "viem";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";

import {
  CELO_ATTRIBUTION_CODE,
  ERC_8021_MARKER,
  attributionSuffix,
  withAttribution,
} from "../attribution.js";
import { PlatformWallet } from "./platform-wallet.js";

const dir = mkdtempSync(join(tmpdir(), "kaada-platform-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const keyFile = (content: string) => {
  const path = join(dir, `k${n++}.key`);
  writeFileSync(path, content, { mode: 0o400 });
  return path;
};

/** A node that answers just enough for viem to sign and "send", and records the raw transaction. */
function fakeNode() {
  const sent: Hex[] = [];
  const transport = custom({
    request: ({ method }: { method: string; params?: unknown }, ..._rest: unknown[]) => {
      void _rest;
      switch (method) {
        case "eth_chainId":
          return Promise.resolve("0xa4ec");
        case "eth_getTransactionCount":
          return Promise.resolve("0x0");
        case "eth_estimateGas":
          return Promise.resolve("0x30d40");
        case "eth_gasPrice":
        case "eth_maxPriorityFeePerGas":
          return Promise.resolve("0x174876e800");
        case "eth_getBlockByNumber":
          return Promise.resolve({
            number: "0x1",
            hash: `0x${"11".repeat(32)}`,
            baseFeePerGas: "0x174876e800",
            timestamp: "0x1",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            transactions: [],
          });
        case "eth_sendRawTransaction":
          return Promise.resolve(`0x${"22".repeat(32)}`);
        default:
          return Promise.reject(new Error(`unexpected ${method}`));
      }
    },
  });
  // viem hands the raw transaction to eth_sendRawTransaction; capture it through the transport wrapper.
  const capturing = ((args: never) => {
    const inner = transport(args);
    const request = inner.request;
    return {
      ...inner,
      request: (req: { method: string; params?: unknown[] }) => {
        if (req.method === "eth_sendRawTransaction") sent.push(req.params?.[0] as Hex);
        return request(req);
      },
    };
  }) as typeof transport;
  return { transport: capturing, sent };
}

const repoRoot = join(dir, "not-the-repo");

describe("the platform wallet", () => {
  it("a valid key derives the expected address (any letter case) and exposes only the public address", () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    for (const expected of [account.address, account.address.toLowerCase()]) {
      const wallet = PlatformWallet.load({
        keyFile: keyFile(`${key}\n`),
        expectedAddress: expected,
        repositoryRoot: repoRoot,
        chain: celo,
      });
      assert.equal(wallet.address, account.address);
      assert.deepEqual(JSON.parse(JSON.stringify(wallet)), { address: account.address });
      assert.equal(
        JSON.stringify(wallet).toLowerCase().includes(key.slice(2).toLowerCase()),
        false,
      );
    }
  });

  it("a malformed or missing key fails, and the error never echoes the file's content", () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const secretLooking = "0xthis-is-not-a-key-but-looks-secret-0123456789abcdef";
    for (const bad of [
      secretLooking,
      "",
      `0x${"ab".repeat(31)}`,
      `0x${"zz".repeat(32)}`,
      "ab".repeat(32),
    ]) {
      assert.throws(
        () =>
          PlatformWallet.load({
            keyFile: keyFile(bad),
            expectedAddress: address,
            repositoryRoot: repoRoot,
            chain: celo,
          }),
        (error: Error) =>
          /32-byte/.test(error.message) &&
          (bad === "" || !error.message.includes(bad.slice(2, 16))),
      );
    }
    assert.throws(
      () =>
        PlatformWallet.load({
          keyFile: join(dir, "missing.key"),
          expectedAddress: address,
          repositoryRoot: repoRoot,
          chain: celo,
        }),
      /ENOENT|no such file/i,
    );
  });

  it("an address that does not match the key refuses to start, naming only public addresses", () => {
    const key = generatePrivateKey();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    assert.throws(
      () =>
        PlatformWallet.load({
          keyFile: keyFile(key),
          expectedAddress: other,
          repositoryRoot: repoRoot,
          chain: celo,
        }),
      (error: Error) =>
        error.message.includes(other.toLowerCase()) &&
        error.message.includes(privateKeyToAccount(key).address.toLowerCase()) &&
        !error.message.includes(key.slice(2)),
    );
    for (const invalid of ["", "0x123", `0x${"0".repeat(40)}`, "not-an-address"]) {
      assert.throws(
        () =>
          PlatformWallet.load({
            keyFile: keyFile(key),
            expectedAddress: invalid,
            repositoryRoot: repoRoot,
            chain: celo,
          }),
        /not a valid address/,
        invalid,
      );
    }
  });

  it("a key file inside the repository is refused", () => {
    assert.throws(
      () =>
        PlatformWallet.load({
          keyFile: join(dir, "inside.key"),
          expectedAddress: privateKeyToAccount(generatePrivateKey()).address,
          repositoryRoot: dir,
          chain: celo,
        }),
      /outside the repository/,
    );
  });

  it("every platform transaction carries celo_51c4a2ae2240 at the end of its calldata, including a plain transfer", async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const node = fakeNode();
    const wallet = PlatformWallet.load({
      keyFile: keyFile(key),
      expectedAddress: account.address,
      repositoryRoot: repoRoot,
      chain: celo,
      transport: node.transport,
    });
    const to = privateKeyToAccount(generatePrivateKey()).address;

    const transfer = wallet.prepare({ to, value: 1n });
    assert.equal(transfer.data, attributionSuffix(CELO_ATTRIBUTION_CODE));
    const call = wallet.prepare({ to, data: "0xa9059cbb" });
    assert.ok(
      call.data.startsWith("0xa9059cbb") && call.data.endsWith(attributionSuffix().slice(2)),
    );

    const { txHash } = await wallet.send({ to, value: 1n, data: "0xa9059cbb" });
    assert.match(txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(node.sent.length, 1);
    const signed = parseTransaction(node.sent[0]!);
    assert.equal(signed.to?.toLowerCase(), to.toLowerCase());
    assert.ok(
      signed.data?.endsWith(attributionSuffix().slice(2)),
      "the signed transaction ends with the tag",
    );
    assert.ok(signed.data?.startsWith("0xa9059cbb"));
    assert.equal(keccak256(node.sent[0]!).length, 66);
  });

  it("the tag is the one the official encoder produces, and is never applied twice", () => {
    // toDataSuffix("celo_51c4a2ae2240") from @celo/attribution-tags: ascii code, length 0x11, schema 0x00, ERC-8021 marker.
    assert.equal(
      attributionSuffix("celo_51c4a2ae2240"),
      "0x63656c6f5f353163346132616532323430110080218021802180218021802180218021",
    );
    assert.equal(CELO_ATTRIBUTION_CODE, "celo_51c4a2ae2240");
    const once = withAttribution("0x1234");
    assert.equal(withAttribution(once), once);
    assert.ok(once.endsWith(ERC_8021_MARKER.slice(2)));
    assert.throws(() => attributionSuffix("Not A Code"), /1-32/);
  });
});
