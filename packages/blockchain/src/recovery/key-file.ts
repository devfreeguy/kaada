import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { Hex } from "viem";

/**
 * Reads a dedicated key (the recovery relayer's gas key) from a file that must live OUTSIDE the repository checkout: a secret
 * never sits next to the code. The file holds the 0x-prefixed 32-byte hex key and nothing else.
 */
export function readKeyFileOutsideRepo(path: string, repositoryRoot: string): Hex {
  const absolute = resolve(path);
  const rel = relative(resolve(repositoryRoot), absolute);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    throw new Error("a signing key file must be stored outside the repository");
  }
  const text = readFileSync(absolute, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text))
    throw new Error("the key file must hold one 0x-prefixed 32-byte hex key");
  return text as Hex;
}
