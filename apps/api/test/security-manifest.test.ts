import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

interface Manifest {
  areas: Record<string, string[]>;
  integration: string[];
}
const manifest = JSON.parse(
  readFileSync(new URL("./security/manifest.json", import.meta.url), "utf8"),
) as Manifest;

const REQUIRED = [
  "passkey root",
  "device-key root",
  "6-digit PIN",
  "delegated permission",
  "recovery",
  "cancellation",
  "attestor veto",
  "root rotation",
  "backup credential",
  "replay protection",
  "restart and reconciliation",
  "race conditions",
];

describe("the security regression manifest", () => {
  it("covers every required area, each with at least one test", () => {
    for (const area of REQUIRED) {
      assert.ok((manifest.areas[area]?.length ?? 0) > 0, `no tests for "${area}"`);
    }
  });

  it("lists only files that exist (so the suite cannot silently shrink)", () => {
    const listed = [...Object.values(manifest.areas).flat(), ...manifest.integration];
    for (const name of listed) {
      assert.ok(existsSync(new URL(`./${name}`, import.meta.url)), `missing test file: ${name}`);
    }
  });
});
