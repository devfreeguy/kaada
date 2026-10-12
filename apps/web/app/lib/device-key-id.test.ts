import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deviceKeyIdFromPoint as fromContracts } from "@kaada/contracts";

import { generateDeviceKey } from "./device-key";
import { deviceKeyIdFromPoint } from "./device-key-id";

describe("the browser derives the same device key id as the server", () => {
  it("for real generated keys", async () => {
    for (let i = 0; i < 10; i += 1) {
      const key = await generateDeviceKey();
      const expected = fromContracts({
        x: BigInt(`0x${key.publicKeyX}`),
        y: BigInt(`0x${key.publicKeyY}`),
      });
      assert.equal(deviceKeyIdFromPoint(key.publicKeyX, key.publicKeyY), expected);
    }
  });
});
