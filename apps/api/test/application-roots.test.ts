import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { after, describe, it } from "node:test";

import { readKeyFileOutsideRepo } from "@kaada/blockchain";
import { generatePrivateKey } from "viem/accounts";

import { applicationRoots } from "../src/security/application-roots.js";

/*
 * The production image has no checkout and no .git: the compiled API lives in /app/dist, its package.json in /app, and the platform key is
 * a read-only single-file bind mount at /run/secrets/platform-agent.key. This builds that layout under a temp directory.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), "kaada-image-")));
after(() => rmSync(base, { recursive: true, force: true }));
const app = join(base, "app");
const moduleDir = join(app, "dist", "security");
const secrets = join(base, "run", "secrets");
mkdirSync(moduleDir, { recursive: true });
mkdirSync(secrets, { recursive: true });
writeFileSync(join(app, "package.json"), "{}");
const key = generatePrivateKey();
const keyPath = join(secrets, "platform-agent.key");
writeFileSync(keyPath, `${key}\n`, { mode: 0o400 });
chmodSync(keyPath, 0o400);

const SETTING = "PLATFORM_WALLET_KEY_FILE";
const roots = () => applicationRoots({ moduleDir, cwd: app });

describe("the container layout", () => {
  it("the application root is /app (the directory with package.json above dist), not the filesystem root", () => {
    assert.deepEqual(roots(), [app]);
  });

  it("the read-only mounted key at <tmp>/run/secrets/platform-agent.key loads", () => {
    assert.equal(readKeyFileOutsideRepo(keyPath, roots(), SETTING), key);
  });

  it("keys under the app directory and under dist are refused", () => {
    for (const inside of [
      join(app, "platform-agent.key"),
      join(app, "dist", "platform-agent.key"),
    ]) {
      writeFileSync(inside, key);
      assert.throws(
        () => readKeyFileOutsideRepo(inside, roots(), SETTING),
        /outside the repository/,
        inside,
      );
    }
    // even a key that does not exist yet, under the app, is refused as being inside
    assert.throws(
      () => readKeyFileOutsideRepo(join(app, "secrets", "x.key"), roots(), SETTING),
      /outside the repository/,
    );
  });

  it("the old fixed '../../../../' walk from /app/dist/<module>/ gives '/', which is why every path was refused", () => {
    const old = new URL("../../../../", "file:///app/dist/recovery/recovery.runtime.js").pathname;
    assert.equal(old, "/");
    // and the guard now refuses such a root outright instead of treating everything as inside it
    assert.throws(
      () => readKeyFileOutsideRepo(keyPath, parse(base).root, SETTING),
      /filesystem root cannot be the application directory/,
    );
  });
});

describe("applicationRoots", () => {
  it("a working directory of '/' is skipped, not an error, while a real root remains", () => {
    assert.deepEqual(applicationRoots({ moduleDir, cwd: parse(base).root }), [app]);
  });

  it("a working directory elsewhere is added as an extra root", () => {
    const other = join(base, "work");
    mkdirSync(other);
    assert.deepEqual([...applicationRoots({ moduleDir, cwd: other })].sort(), [app, other].sort());
  });

  it("with no package.json above the module and a '/' working directory there is no valid root: it throws, never falls back to '/'", () => {
    // a module directly under the filesystem root has no application directory above it (an ancestor of the temp directory might
    // otherwise hold a package.json on a developer machine)
    const bare = parse(base).root;
    assert.throws(
      () => applicationRoots({ moduleDir: bare, cwd: parse(base).root }),
      /cannot determine the application directory/,
    );
  });

  it("from the real source tree it finds the workspace root and the API directory", () => {
    const found = applicationRoots();
    assert.ok(
      found.some((root) => /apps[\\/]api$/.test(root)),
      found.join(","),
    );
    assert.ok(found.every((root) => parse(root).root !== root));
  });

  it("roots are canonical, so a symlinked app directory is protected under its real path", () => {
    const alias = join(base, "alias-of-app");
    symlinkSync(app, alias, "junction");
    const viaAlias = applicationRoots({ moduleDir: join(alias, "dist", "security"), cwd: alias });
    assert.deepEqual(viaAlias, [app]);
    assert.throws(
      () => readKeyFileOutsideRepo(join(app, "dist", "platform-agent.key"), viaAlias, SETTING),
      /outside the repository/,
    );
  });

  it("symlink escapes in both directions are refused through the roots the app really uses", () => {
    // inside -> out: a link under /app pointing at the secrets directory
    symlinkSync(secrets, join(app, "to-secrets"), "junction");
    assert.throws(
      () => readKeyFileOutsideRepo(join(app, "to-secrets", "platform-agent.key"), roots(), SETTING),
      /outside the repository/,
    );
    // outside -> in: a link under the secrets directory pointing at /app/dist
    writeFileSync(join(app, "dist", "real.key"), key);
    symlinkSync(join(app, "dist"), join(secrets, "to-dist"), "junction");
    assert.throws(
      () => readKeyFileOutsideRepo(join(secrets, "to-dist", "real.key"), roots(), SETTING),
      /outside the repository/,
    );
  });
});
