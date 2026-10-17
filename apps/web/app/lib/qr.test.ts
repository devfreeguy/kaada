import assert from "node:assert/strict";
import { test } from "node:test";

import { groupSecret } from "./recovery-copy";
import { qrMatrix } from "./qr";

const URI =
  "otpauth://totp/Kaada:ada%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Kaada&algorithm=SHA1&digits=6&period=30";

test("an authenticator provisioning URI becomes a square QR matrix with the three finder patterns", () => {
  const matrix = qrMatrix(URI);
  const n = matrix.length;
  assert.ok(n >= 25 && n <= 61, String(n));
  assert.ok(matrix.every((row) => row.length === n));
  // Finder pattern: a 7x7 square ring with a 3x3 core, at the top-left, top-right and bottom-left corners.
  for (const [r0, c0] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ] as const) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(matrix[r0 + r]?.[c0 + c], ring || core, `finder at ${r0},${c0} (${r},${c})`);
      }
    }
  }
});

test("the same text always gives the same code, different text a different one", () => {
  assert.deepEqual(qrMatrix(URI), qrMatrix(URI));
  assert.notDeepEqual(qrMatrix(URI), qrMatrix(`${URI}x`));
});

test("the setup key is shown in readable groups", () => {
  assert.equal(groupSecret("JBSWY3DPEHPK3PXP"), "JBSW Y3DP EHPK 3PXP");
});
