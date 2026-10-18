import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Hex } from "viem";

/** Why a key file could not be read, in words an operator can act on. Never the path's content, never the key. */
function unreadableReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return "file not found";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EISDIR":
      return "the path is a directory, not a file";
    default:
      return typeof code === "string" ? `could not be read (${code})` : "could not be read";
  }
}

/** True when `target` is `root` itself or anywhere below it. Purely lexical; both must already be absolute and normalised. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The path with every symlink resolved, or just normalised when it does not exist (a root that is not there excludes nothing). */
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Reads a dedicated key (the recovery relayer's gas key, the platform wallet's key) from a file that must live OUTSIDE the
 * application: a secret never sits next to the code. The file holds the 0x-prefixed 32-byte hex key and nothing else.
 *
 * `roots` are the directories the key must not be under (the checkout, or the app directory in the image). The path is judged twice:
 * as written, and with every symlink resolved on both the key and every root, so a link inside a root pointing out of it, or a link
 * outside pointing in, cannot get a key past the guard. A root that is the filesystem root is refused outright: it would make every
 * path "inside" (or, if skipped silently, the guard would protect nothing).
 *
 * `setting` is the environment variable that named the file; a missing or unreadable file is reported against it, and a key path
 * that does not exist is reported as missing rather than as being inside the repository.
 */
export function readKeyFileOutsideRepo(
  path: string,
  roots: string | readonly string[],
  setting: string,
): Hex {
  const rootList = typeof roots === "string" ? [roots] : [...roots];
  if (rootList.length === 0)
    throw new Error("no application directory was given to keep keys out of");
  const absolute = resolve(path);
  const lexicalRoots = rootList.map((root) => resolve(root));
  for (const root of lexicalRoots) {
    if (dirname(root) === root)
      throw new Error("the filesystem root cannot be the application directory");
  }
  // 1. As written: a key path under a root is refused, whether or not the file exists.
  if (lexicalRoots.some((root) => isInside(root, absolute))) {
    throw new Error("a signing key file must be stored outside the repository");
  }
  // 2. With symlinks resolved. A path that does not exist cannot be resolved: that is a missing file, not a repository problem.
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (error) {
    throw new Error(`${setting}: cannot read the key file: ${unreadableReason(error)}`);
  }
  if (rootList.some((root) => isInside(canonical(root), real))) {
    throw new Error("a signing key file must be stored outside the repository");
  }
  let raw: string;
  try {
    raw = readFileSync(real, "utf8");
  } catch (error) {
    throw new Error(`${setting}: cannot read the key file: ${unreadableReason(error)}`);
  }
  const text = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text))
    throw new Error("the key file must hold one 0x-prefixed 32-byte hex key");
  return text as Hex;
}
