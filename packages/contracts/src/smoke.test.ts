import assert from "node:assert/strict";
import test from "node:test";

import { artifacts } from "./generated/artifacts.js";
import { TestChain } from "./testing/evm.js";

test("smoke: the in-process EVM deploys and calls a contract", async () => {
  const chain = await TestChain.create();
  const owner = "0x1000000000000000000000000000000000000001" as const;
  const account = await chain.deploy(
    owner,
    artifacts.MockAccount.abi,
    artifacts.MockAccount.bytecode,
  );
  const result = await chain.call(owner, account, artifacts.MockAccount.abi, "currentNonce");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 1);
});
