import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveRecoveryKey as contractsDerive,
  generateRecoveryCode as contractsGenerate,
  parseRecoveryCode as contractsParse,
  recoveryDomain,
  recoveryInitiateTypes,
} from "@kaada/contracts";
import { recoverTypedDataAddress } from "viem";
import type { Address, Hex } from "viem";

import {
  deriveRecoveryKey,
  formatRecoveryCode,
  generateRecoveryCode,
  parseRecoveryCode,
  signRecovery,
} from "./recovery-code";

const ACCOUNT: Address = "0x1111111111111111111111111111111111111111";
const VALIDATOR: Address = "0x2222222222222222222222222222222222222222";

describe("the browser Recovery Code matches the contracts package", () => {
  it("derives the same key and address for the same code, chain and account", () => {
    for (let i = 0; i < 25; i += 1) {
      const code = contractsGenerate();
      const mine = deriveRecoveryKey(code.canonical(), { chainId: 11142220, account: ACCOUNT });
      const theirs = contractsDerive(code, { chainId: 11142220, account: ACCOUNT });
      assert.deepEqual(mine, theirs);
    }
  });

  it("is bound to the chain and the account", () => {
    const code = generateRecoveryCode();
    const base = deriveRecoveryKey(code, { chainId: 1, account: ACCOUNT });
    assert.notEqual(
      deriveRecoveryKey(code, { chainId: 2, account: ACCOUNT }).address,
      base.address,
    );
    assert.notEqual(
      deriveRecoveryKey(code, { chainId: 1, account: VALIDATOR }).address,
      base.address,
    );
  });

  it("generates 26 characters, parses what it shows, and refuses malformed input", () => {
    const code = generateRecoveryCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(formatRecoveryCode(code), /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}-[0-9A-Z]{6}$/);
    assert.equal(parseRecoveryCode(formatRecoveryCode(code).toLowerCase()), code);
    assert.equal(parseRecoveryCode("short"), null);
    assert.equal(parseRecoveryCode(`${code.slice(0, 25)}U`), null);
    const sample = contractsGenerate();
    assert.equal(parseRecoveryCode(sample.reveal()), contractsParse(sample.reveal())?.canonical());
    assert.notEqual(generateRecoveryCode(), generateRecoveryCode());
  });
});

describe("signing the server's recovery request", () => {
  const typed = {
    domain: { ...recoveryDomain(11142220, VALIDATOR) },
    types: recoveryInitiateTypes as unknown as Record<string, { name: string; type: string }[]>,
    primaryType: "Initiate" as const,
    message: {
      account: ACCOUNT,
      nonce: "3",
      rootId: `0x01${"22".repeat(20)}`,
      hook: "0x0000000000000000000000000000000000000000",
      validatorDataHash: `0x${"aa".repeat(32)}`,
      hookDataHash: `0x${"bb".repeat(32)}`,
      deadline: "1900000000",
    },
  };

  it("produces a signature the contract's domain recovers to the code's address", async () => {
    const code = generateRecoveryCode();
    const expected = { chainId: 11142220, account: ACCOUNT };
    const signature = await signRecovery(code, expected, typed);
    const signer = await recoverTypedDataAddress({
      domain: recoveryDomain(11142220, VALIDATOR),
      types: recoveryInitiateTypes,
      primaryType: "Initiate",
      message: {
        account: ACCOUNT,
        nonce: 3n,
        rootId: typed.message.rootId as Hex,
        hook: typed.message.hook as Address,
        validatorDataHash: typed.message.validatorDataHash as Hex,
        hookDataHash: typed.message.hookDataHash as Hex,
        deadline: 1_900_000_000n,
      },
      signature,
    });
    assert.equal(signer, deriveRecoveryKey(code, expected).address);
  });

  it("refuses to sign a request for another chain, another account or another kind of message", async () => {
    const code = generateRecoveryCode();
    const expected = { chainId: 11142220, account: ACCOUNT };
    await assert.rejects(
      signRecovery(code, expected, { ...typed, domain: { ...typed.domain, chainId: 1 } }),
      /another chain/,
    );
    await assert.rejects(
      signRecovery(code, expected, {
        ...typed,
        message: { ...typed.message, account: VALIDATOR },
      }),
      /another account/,
    );
    await assert.rejects(
      signRecovery(code, expected, { ...typed, primaryType: "Transfer" as never }),
      /unexpected/,
    );
  });
});
