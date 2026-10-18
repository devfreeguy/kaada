import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directories a signing key file must NOT live under, in one place for every caller that loads a key file (the recovery relayer,
 * the device-key relayer, the platform wallet), so they cannot drift apart.
 *
 *  - the workspace root (the directory with `pnpm-workspace.yaml`) when running from a checkout;
 *  - the application directory: the nearest directory with a `package.json` above this module (`apps/api` in a checkout, `/app` in
 *    the production image, which has no checkout and no `.git`);
 *  - the process working directory.
 *
 * Found by walking UP from this module, never by counting `../` (that gave `/` in the image, where `dist` sits one level from the app
 * directory, and rejected every path). The filesystem root is never a root and never a fallback: it is skipped (so a working
 * directory of `/` is ignored), and when nothing valid remains this throws, so the process does not start with a guard that protects
 * nothing. Symlinks are resolved so the roots match the resolved key path the guard compares.
 */
export function applicationRoots(input: { moduleDir?: string; cwd?: string } = {}): string[] {
  const moduleDir = resolve(input.moduleDir ?? dirname(fileURLToPath(import.meta.url)));
  const cwd = resolve(input.cwd ?? process.cwd());
  const found = [
    nearestAncestorWith(moduleDir, "pnpm-workspace.yaml"),
    nearestAncestorWith(moduleDir, "package.json"),
    cwd,
  ];
  const roots = new Set<string>();
  for (const candidate of found) {
    if (candidate === undefined || isFilesystemRoot(candidate)) continue;
    roots.add(canonical(candidate));
  }
  const valid = [...roots].filter((root) => !isFilesystemRoot(root));
  if (valid.length === 0)
    throw new Error("cannot determine the application directory, so key files cannot be checked");
  return valid;
}

function isFilesystemRoot(path: string): boolean {
  const absolute = resolve(path);
  return dirname(absolute) === absolute;
}

function canonical(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** The closest directory at or above `start` that contains `name`; undefined when only the filesystem root would match. */
function nearestAncestorWith(start: string, name: string): string | undefined {
  let current = start;
  for (;;) {
    if (isFilesystemRoot(current)) return undefined;
    if (existsSync(join(current, name))) return current;
    current = dirname(current);
  }
}
