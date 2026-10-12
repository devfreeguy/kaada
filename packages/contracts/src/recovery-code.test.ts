import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";

import { recoverTypedDataAddress } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  RECOVERY_CODE_LENGTH,
  deriveRecoveryKey,
  formatRecoveryCode,
  generateRecoveryCode,
  parseRecoveryCode,
} from "./recovery-code.js";
import { recoveryDomain, recoveryInitiateMessage, recoveryInitiateTypes } from "./recovery.js";

const ACCOUNT: Address = "0x1111111111111111111111111111111111111111";
const OTHER: Address = "0x2222222222222222222222222222222222222222";
const fixed = (byte: number) => () => new Uint8Array(17).fill(byte);

test("a code is 26 Crockford base32 characters (130 bits), shown as 5-5-5-5-6 groups", () => {
  const code = generateRecoveryCode();
  assert.equal(code.canonical().length, RECOVERY_CODE_LENGTH);
  assert.match(code.canonical(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(code.reveal(), /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}-[0-9A-Z]{6}$/);
  assert.equal(parseRecoveryCode(code.reveal())?.canonical(), code.canonical());
});

test("130 bits are used: the top 130 of 136 random bits, and different bytes give different codes", () => {
  assert.equal(generateRecoveryCode(fixed(0)).canonical(), "0".repeat(26));
  assert.equal(generateRecoveryCode(fixed(0xff)).canonical(), "Z".repeat(26));
  const a = generateRecoveryCode(() => Uint8Array.from({ length: 17 }, (_, i) => i));
  const b = generateRecoveryCode(() =>
    Uint8Array.from({ length: 17 }, (_, i) => (i === 16 ? 0x40 : i)),
  );
  assert.notEqual(a.canonical(), b.canonical(), "the last used bit matters");
  // the 6 unused low bits do not
  const c = generateRecoveryCode(() =>
    Uint8Array.from({ length: 17 }, (_, i) => (i === 16 ? 0x3f : i)),
  );
  assert.equal(a.canonical(), c.canonical());
  assert.throws(() => generateRecoveryCode(() => new Uint8Array(16)));
});

test("fuzz: 500 generated codes are unique, well formed and parse back", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const code = generateRecoveryCode();
    seen.add(code.canonical());
    assert.equal(parseRecoveryCode(code.reveal())?.canonical(), code.canonical());
  }
  assert.equal(seen.size, 500);
});

test("parsing ignores case, spaces and dashes, maps look-alikes, and rejects everything else", () => {
  const code = generateRecoveryCode(() => Uint8Array.from({ length: 17 }, (_, i) => i * 7));
  const shown = code.reveal();
  assert.equal(
    parseRecoveryCode(shown.toLowerCase().replace(/-/g, " "))?.canonical(),
    code.canonical(),
  );
  assert.equal(
    parseRecoveryCode("O".repeat(13) + "I".repeat(13))?.canonical(),
    "0".repeat(13) + "1".repeat(13),
  );
  assert.equal(parseRecoveryCode("L".repeat(26))?.canonical(), "1".repeat(26));
  for (const bad of [
    "",
    "ABC",
    `${shown}A`,
    shown.slice(0, -1),
    "U".repeat(26),
    "!".repeat(26),
    `${shown.slice(0, 25)}*`,
  ]) {
    assert.equal(parseRecoveryCode(bad), null, bad);
  }
  assert.equal(formatRecoveryCode("A".repeat(26)), "AAAAA-AAAAA-AAAAA-AAAAA-AAAAAA");
});

test("the code never prints: toString, JSON, template strings and util.inspect are redacted", () => {
  const code = generateRecoveryCode();
  const secret = code.canonical();
  for (const text of [
    String(code),
    `${code.toString()}`,
    JSON.stringify({ code }),
    JSON.stringify(code),
    inspect(code),
    inspect({ nested: { code } }, { depth: 5 }),
  ]) {
    assert.ok(!text.includes(secret), text);
    assert.ok(!text.includes(code.reveal()), text);
  }
  assert.equal(code.reveal().replace(/-/g, ""), secret, "reveal() is the one explicit way out");
});

test("the derived key is deterministic and bound to the chain and the account", () => {
  const code = generateRecoveryCode();
  const base = deriveRecoveryKey(code, { chainId: 11142220, account: ACCOUNT });
  assert.deepEqual(deriveRecoveryKey(code, { chainId: 11142220, account: ACCOUNT }), base);
  assert.equal(
    deriveRecoveryKey(code, {
      chainId: 11142220n,
      account: ACCOUNT.toUpperCase().replace("0X", "0x") as Address,
    }).address,
    base.address,
  );
  assert.notEqual(
    deriveRecoveryKey(code, { chainId: 42220, account: ACCOUNT }).address,
    base.address,
    "another chain",
  );
  assert.notEqual(
    deriveRecoveryKey(code, { chainId: 11142220, account: OTHER }).address,
    base.address,
    "another account",
  );
  assert.notEqual(
    deriveRecoveryKey(generateRecoveryCode(), { chainId: 11142220, account: ACCOUNT }).address,
    base.address,
  );
  assert.match(base.privateKey, /^0x[0-9a-f]{64}$/);
  assert.equal(privateKeyToAccount(base.privateKey).address, base.address);
});

test("a known vector stays stable (changing the KDF would lock every user out)", () => {
  const code = parseRecoveryCode("00000-00000-00000-00000-000000");
  assert.ok(code);
  const key = deriveRecoveryKey(code, { chainId: 1, account: ACCOUNT });
  // Pinned: if this changes, existing Recovery Codes stop working.
  assert.equal(key.address, "0xA6004d606313f20C6D3E79b6b78fD2352257e297");
});

test("fuzz: derived keys are always valid secp256k1 scalars and differ per code", () => {
  const addresses = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const { privateKey, address } = deriveRecoveryKey(generateRecoveryCode(), {
      chainId: 11142220,
      account: ACCOUNT,
    });
    const scalar = BigInt(privateKey);
    assert.ok(
      scalar > 0n && scalar < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
    );
    addresses.add(address);
  }
  assert.equal(addresses.size, 200);
});

test("the derived key signs the recovery Initiate message exactly as the contract expects", async () => {
  const code = generateRecoveryCode();
  const { privateKey, address } = deriveRecoveryKey(code, { chainId: 11142220, account: ACCOUNT });
  const validator: Address = "0x3333333333333333333333333333333333333333";
  const root = {
    validator: "0x4444444444444444444444444444444444444444" as Address,
    hook: "0x0000000000000000000000000000000000000000" as Address,
    validatorData: "0x1234" as Hex,
    hookData: "0x" as Hex,
  };
  const message = recoveryInitiateMessage({
    account: ACCOUNT,
    nonce: 0n,
    root,
    deadline: 1_900_000_000n,
  });
  const signature = await privateKeyToAccount(privateKey).signTypedData({
    domain: recoveryDomain(11142220, validator),
    types: recoveryInitiateTypes,
    primaryType: "Initiate",
    message,
  });
  const signer = await recoverTypedDataAddress({
    domain: recoveryDomain(11142220, validator),
    types: recoveryInitiateTypes,
    primaryType: "Initiate",
    message,
    signature,
  });
  assert.equal(signer, address);
});
