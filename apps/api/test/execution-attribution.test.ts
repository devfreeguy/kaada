import "reflect-metadata";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CELO_ATTRIBUTION_CODE, attributionSuffix } from "@kaada/blockchain";

import { kernelAdapterConfig } from "../src/execution/execution.module.js";

/*
 * Production user UserOperations are tagged for the Celo attribution program. The adapter appends whatever suffix it is given to
 * every UserOperation's callData (proven live on Celo mainnet by the canary); this pins that the PRODUCTION wiring gives it one,
 * the right one, once.
 */

const config = { wallet: { rpcUrl: "https://forno.celo.org" } } as never;
const source = readFileSync(
  fileURLToPath(new URL("../src/execution/execution.module.ts", import.meta.url)),
  "utf8",
);

describe("production execution wiring carries the Celo attribution", () => {
  it("the adapter configuration includes the celo_51c4a2ae2240 ERC-8021 suffix, exactly as the official encoder produces it", () => {
    const adapter = kernelAdapterConfig(config, "https://bundler.example/rpc");
    assert.equal(CELO_ATTRIBUTION_CODE, "celo_51c4a2ae2240");
    assert.equal(
      adapter.attributionSuffix,
      "0x63656c6f5f353163346132616532323430110080218021802180218021802180218021",
    );
    assert.equal(adapter.attributionSuffix, attributionSuffix(CELO_ATTRIBUTION_CODE));
    assert.equal(adapter.bundlerUrl, "https://bundler.example/rpc");
    assert.equal(adapter.rpcUrl, "https://forno.celo.org");
  });

  it("the KERNEL_EXECUTION_PORT provider builds the adapter from that function and from nothing else", () => {
    const calls = [...source.matchAll(/createZeroDevKernelAdapter\(([^;]*)\)/g)].map((m) => m[1]);
    assert.equal(calls.length, 1, "exactly one place builds the production adapter");
    assert.match(calls[0] ?? "", /^kernelAdapterConfig\(config, config\.execution\.bundlerUrl\)$/);
  });

  it("the suffix is applied in one place only: no second encoder, no hand-written suffix in the module", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal((code.match(/attributionSuffix\(\)/g) ?? []).length, 1);
    assert.equal(/80218021|celo_[0-9a-f]{12}|toDataSuffix/.test(code), false);
  });
});
