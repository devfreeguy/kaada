import assert from "node:assert/strict";
import fs, {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { after, describe, it, mock } from "node:test";

import { generatePrivateKey } from "viem/accounts";

import { readKeyFileOutsideRepo } from "./key-file.js";

const dir = mkdtempSync(join(tmpdir(), "kaada-keyfile-"));
after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(dir, { recursive: true, force: true });
});
const repo = join(dir, "not-the-repo");
const SETTING = "PLATFORM_WALLET_KEY_FILE";

describe("a key file that cannot be read", () => {
  it("a missing file is reported against the env var as 'file not found'", () => {
    assert.throws(
      () => readKeyFileOutsideRepo(join(dir, "absent.key"), repo, SETTING),
      (error: Error) => error.message === `${SETTING}: cannot read the key file: file not found`,
    );
  });

  it("the env var named is the one passed in", () => {
    assert.throws(
      () => readKeyFileOutsideRepo(join(dir, "absent.key"), repo, "RECOVERY_RELAYER_KEY_FILE"),
      /^Error: RECOVERY_RELAYER_KEY_FILE: cannot read the key file: file not found$/,
    );
  });

  it("a path that is a directory (Docker creates one for a missing mount source) is called out", () => {
    assert.throws(
      () => readKeyFileOutsideRepo(dir, repo, SETTING),
      (error: Error) =>
        error.message ===
        `${SETTING}: cannot read the key file: the path is a directory, not a file`,
    );
  });

  it("a permission error is reported as 'permission denied'", () => {
    const path = join(dir, "locked.key");
    writeFileSync(path, generatePrivateKey());
    const original = fs.readFileSync;
    mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
      if (String(args[0]) === realpathSync(path)) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
          code: "EACCES",
        });
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => readKeyFileOutsideRepo(path, repo, SETTING),
        (error: Error) =>
          error.message === `${SETTING}: cannot read the key file: permission denied`,
      );
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it("an unexpected error code is reported by code, and no message carries the path or any key", () => {
    const path = join(dir, "weird.key");
    const key = generatePrivateKey();
    writeFileSync(path, key);
    const original = fs.readFileSync;
    mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
      if (String(args[0]) === realpathSync(path))
        throw Object.assign(new Error(`EIO: i/o error, read '${path}' ${key}`), { code: "EIO" });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => readKeyFileOutsideRepo(path, repo, SETTING),
        (error: Error) =>
          error.message === `${SETTING}: cannot read the key file: could not be read (EIO)` &&
          !error.message.includes(path) &&
          !error.message.includes(key),
      );
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it("the message never contains the path", () => {
    const path = join(dir, "secret-looking-name-0123456789.key");
    assert.throws(
      () => readKeyFileOutsideRepo(path, repo, SETTING),
      (error: Error) => !error.message.includes("secret-looking-name"),
    );
  });
});

describe("symlinks and the filesystem root", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kaada-links-")));
  after(() => rmSync(base, { recursive: true, force: true }));
  const app = join(base, "app");
  const outside = join(base, "run", "secrets");
  mkdirSync(join(app, "dist"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const key = generatePrivateKey();
  writeFileSync(join(outside, "platform-agent.key"), key);
  writeFileSync(join(app, "dist", "inside.key"), key);

  it("a key outside the root loads (the production mount layout)", () => {
    assert.equal(readKeyFileOutsideRepo(join(outside, "platform-agent.key"), app, SETTING), key);
  });

  it("a symlink INSIDE the root that points OUT is refused: the link path is inside", () => {
    symlinkSync(outside, join(app, "linked-secrets"), "junction");
    assert.throws(
      () => readKeyFileOutsideRepo(join(app, "linked-secrets", "platform-agent.key"), app, SETTING),
      /outside the repository/,
    );
  });

  it("a symlink OUTSIDE the root that points IN is refused: the real file is inside", () => {
    symlinkSync(join(app, "dist"), join(outside, "looks-outside"), "junction");
    assert.throws(
      () => readKeyFileOutsideRepo(join(outside, "looks-outside", "inside.key"), app, SETTING),
      /outside the repository/,
    );
  });

  it("a symlinked ROOT is resolved too: the real directory is protected", () => {
    const alias = join(base, "app-alias");
    symlinkSync(app, alias, "junction");
    assert.throws(
      () => readKeyFileOutsideRepo(join(app, "dist", "inside.key"), alias, SETTING),
      /outside the repository/,
    );
  });

  it("a missing key outside the root is a missing file, not a repository error", () => {
    assert.throws(
      () => readKeyFileOutsideRepo(join(outside, "nope.key"), app, SETTING),
      /cannot read the key file: file not found/,
    );
  });

  it("the filesystem root is never accepted as a root, alone or among others", () => {
    for (const roots of [parse(base).root, [app, parse(base).root], ["/"]])
      assert.throws(
        () => readKeyFileOutsideRepo(join(outside, "platform-agent.key"), roots, SETTING),
        /filesystem root cannot be the application directory/,
      );
    assert.throws(
      () => readKeyFileOutsideRepo(join(outside, "platform-agent.key"), [], SETTING),
      /no application directory/,
    );
  });

  it("a sibling whose name merely starts with the root's is not inside it", () => {
    const sibling = join(base, "app-other");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "k.key"), key);
    assert.equal(readKeyFileOutsideRepo(join(sibling, "k.key"), app, SETTING), key);
  });
});

describe("the repository check and the key format are unchanged", () => {
  it("a file inside the repository is refused BEFORE it is read, even if it does not exist", () => {
    assert.throws(
      () => readKeyFileOutsideRepo(join(repo, "k.key"), repo, SETTING),
      /^Error: a signing key file must be stored outside the repository$/,
    );
    assert.throws(
      () => readKeyFileOutsideRepo(join(repo, "sub", "..", "k.key"), repo, SETTING),
      /outside the repository/,
    );
  });

  it("a readable file still needs one 0x-prefixed 32-byte hex key (trailing newline allowed)", () => {
    const key = generatePrivateKey();
    const path = join(dir, "ok.key");
    writeFileSync(path, `${key}\n`);
    assert.equal(readKeyFileOutsideRepo(path, repo, SETTING), key);
    for (const [name, content] of [
      ["no0x", key.slice(2)],
      ["short", key.slice(0, 40)],
      ["two", `${key}\n${key}`],
      ["empty", ""],
    ] as const) {
      const bad = join(dir, `${name}.key`);
      writeFileSync(bad, content);
      assert.throws(() => readKeyFileOutsideRepo(bad, repo, SETTING), /0x-prefixed 32-byte/, name);
    }
  });
});
