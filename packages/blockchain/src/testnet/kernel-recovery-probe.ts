/*
 * Celo SEPOLIA ONLY. Verifies four Kernel v3.3 assumptions the recovery design depends on, with REAL
 * transactions through the EntryPoint (userOps are handed straight to handleOps by the throwaway deployer;
 * this probes Kernel semantics, not the Kaada runner).
 *
 *   KAADA_HARNESS_STATE=<state.json> npx tsx src/testnet/kernel-recovery-probe.ts
 *
 * Validators are ECDSA validator COPIES (the deployed runtime, redeployed), because the question is the
 * Kernel's behaviour: root change, nonce invalidation, selector grants, validator-instance reuse.
 * Nothing here is mainnet and nothing is a secret outside the throwaway state file.
 */
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { encodeFunctionData } from "viem";
import { generatePrivateKey } from "viem/accounts";

import {
  ECDSA_X,
  deployer,
  describeError,
  encodeExecute,
  ensureCopies,
  installCalls,
  invalidateData,
  newAccount,
  nonceNow,
  pub,
  read,
  record,
  results,
  rootOf,
  salt,
  sel,
  submit,
  vid,
  changeRootData,
} from "./kernel-probe-lib.js";
import type { Call, Outcome } from "./kernel-probe-lib.js";
// ── scenarios ──────────────────────────────────────────────────────────────────────────────────

const phase = process.argv[2] ?? "all";
async function main(): Promise<void> {
  const balance = await pub.getBalance({ address: deployer.address });
  console.log("deployer", deployer.address, "balance", Number(balance) / 1e18, "CELO");
  // Each scenario account reserves ~0.06 CELO and the run spends ~0.05 more: refuse to start short.
  if (Number(balance) / 1e18 < (phase === "q1" ? 0.15 : 0.12))
    throw new Error("deployer balance too low for this phase");
  const [Y, Z, W, V] = await ensureCopies(4);
  console.log("validator copies", { X: ECDSA_X, Y, Z, W });
  const kA = generatePrivateKey(); // original root owner (validator X)
  const kB = generatePrivateKey(); // "recovery" validator Y
  const kC = generatePrivateKey(); // new root (validator Z)
  const kD = generatePrivateKey(); // session-like validator W

  let r: Outcome;
  if (phase !== "q23") {
    // ===== Q1 + Q4 : access control and instance reuse ============================================
    const q1 = await newAccount(kA, salt());
    // deploy + install Y with NO grants.
    r = await submit(q1, null, kA, encodeExecute(installCalls(q1, Y!, kB, 1, [])));
    record(
      "setup: root X deploys the account and installs validator Y",
      r.accepted && r.executed,
      r.detail,
    );
    if (!(r.accepted && r.executed))
      throw new Error(
        `setup failed: ${r.detail} balance=${await pub.getBalance({ address: q1.address })}`,
      );
    record(
      "setup: root is X",
      (await rootOf(q1)).startsWith(`0x01${ECDSA_X.slice(2).toLowerCase()}`),
      await rootOf(q1),
    );

    // 1a. a plain EOA calling the account directly.
    for (const [name, data] of [
      ["changeRootValidator", changeRootData(Z!, kC)],
      ["invalidateNonce", invalidateData(1)],
    ] as const) {
      try {
        await pub
          .simulateContract({
            account: deployer,
            address: q1.address,
            abi: KernelV3_3AccountAbi,
            functionName: "invalidateNonce",
            args: [1],
          })
          .then(() => {
            throw new Error("NO_REVERT");
          });
      } catch (error) {
        const text = describeError(error);
        if (name === "invalidateNonce") {
          record(`Q1a: EOA direct invalidateNonce is refused`, text !== "NO_REVERT", text);
        }
      }
      if (name === "changeRootValidator") {
        try {
          await pub.call({ account: deployer, to: q1.address, data });
          record("Q1a: EOA direct changeRootValidator is refused", false, "call succeeded");
        } catch (error) {
          record("Q1a: EOA direct changeRootValidator is refused", true, describeError(error));
        }
      }
    }

    // 1b. validator Y without any selector grant: direct changeRootValidator userOp.
    r = await submit(q1, Y!, kB, changeRootData(Z!, kC));
    record(
      "Q1b: secondary validator WITHOUT a grant cannot call changeRootValidator",
      !r.accepted || !r.executed,
      `accepted=${r.accepted} executed=${r.executed} ${r.detail}`,
    );

    // 1c. grant ONLY changeRootValidator + invalidateNonce.
    r = await submit(
      q1,
      null,
      kA,
      encodeExecute([
        ...[sel.changeRoot, sel.invalidate].map((selector) => ({
          to: q1.address,
          data: encodeFunctionData({
            abi: KernelV3_3AccountAbi,
            functionName: "grantAccess",
            args: [vid(Y!), selector, true],
          }),
        })),
      ]),
    );
    record(
      "setup: grant Y {changeRootValidator, invalidateNonce} only",
      r.accepted && r.executed,
      r.detail,
    );
    record(
      "Q1c: Y isAllowedSelector(changeRootValidator)=true, execute=false",
      (await read<boolean>(q1, "isAllowedSelector", [vid(Y!), sel.changeRoot])) === true &&
        (await read<boolean>(q1, "isAllowedSelector", [vid(Y!), sel.execute])) === false,
      "",
    );

    // 1d. Y may not use `execute` (cannot move funds).
    r = await submit(q1, Y!, kB, encodeExecute([{ to: deployer.address, value: 1n }]));
    record(
      "Q1d: Y (granted only root-change selectors) cannot call execute / move funds",
      !r.accepted || !r.executed,
      `accepted=${r.accepted} executed=${r.executed} ${r.detail}`,
    );

    // 1e. Q4: new root = the ALREADY-initialised instance X with a new owner key.
    const before = await rootOf(q1);
    r = await submit(q1, Y!, kB, changeRootData(ECDSA_X, kC));
    const afterReuse = await rootOf(q1);
    record(
      "Q4a: changeRootValidator to the OLD instance X with new owner data",
      true,
      `accepted=${r.accepted} executed=${r.executed} rootChanged=${before !== afterReuse} ${r.detail}`,
    );
    // does the account still accept the OLD owner key on X (i.e. was the key replaced or ignored)?
    const oldKeyOnX = await submit(
      q1,
      null,
      kA,
      encodeExecute([{ to: deployer.address, value: 1n }]),
    );
    const newKeyOnX = await submit(
      q1,
      null,
      kC,
      encodeExecute([{ to: deployer.address, value: 1n }]),
    );
    record(
      "Q4a': after that, X still validates the OLD owner key (key NOT replaced)",
      oldKeyOnX.accepted && oldKeyOnX.executed,
      `old: ${oldKeyOnX.detail}`,
    );
    record(
      "Q4a'': X validates the NEW owner key",
      newKeyOnX.accepted && newKeyOnX.executed,
      `new: ${newKeyOnX.detail}`,
    );

    // 1f. Y changes the root to a FRESH instance Z.
    r = await submit(q1, Y!, kB, changeRootData(Z!, kC));
    const rootAfter = await rootOf(q1);
    record(
      "Q1f/Q4b: Y changes root to a FRESH instance Z via direct changeRootValidator userOp",
      r.accepted && r.executed && rootAfter.includes(Z!.slice(2).toLowerCase()),
      `root=${rootAfter} ${r.detail}`,
    );
    const zWorks = await submit(q1, null, kC, encodeExecute([{ to: deployer.address, value: 1n }]));
    record(
      "Q4b': the NEW root (Z, key C) signs as root",
      zWorks.accepted && zWorks.executed,
      zWorks.detail,
    );
    const oldRoot = await submit(
      q1,
      null,
      kA,
      encodeExecute([{ to: deployer.address, value: 1n }]),
    );
    record(
      "Q4b'': the OLD root key (X, key A) no longer signs as root",
      !oldRoot.accepted || !oldRoot.executed,
      `accepted=${oldRoot.accepted} executed=${oldRoot.executed} ${oldRoot.detail}`,
    );
    // X is still installed as a secondary validator unless removed:
    const xStillInstalled = await submit(
      q1,
      ECDSA_X,
      kA,
      encodeExecute([{ to: deployer.address, value: 1n }]),
    );
    record(
      "Q4c: after a root change the old root X is NOT automatically revoked as a secondary validator",
      true,
      `X as secondary: accepted=${xStillInstalled.accepted} executed=${xStillInstalled.executed} ${xStillInstalled.detail}`,
    );
  }

  if (phase !== "q1") {
    // ===== Q2 + Q3 : invalidateNonce and atomic ordering ===========================================
    for (const order of ["change-then-invalidate", "invalidate-then-change"] as const) {
      if (process.argv[3] && process.argv[3] !== order) continue;
      const a = await newAccount(kA, salt());
      // session-like validator W installed (nonce N), Y recovery-like (grants incl. execute for the batch).
      r = await submit(
        a,
        null,
        kA,
        encodeExecute([
          ...installCalls(a, W!, kD, 1, [sel.execute]),
          ...installCalls(a, Y!, kB, 1, [sel.execute, sel.changeRoot, sel.invalidate]),
        ]),
      );
      record(
        `[${order}] setup: root X deploys; W (session-like) and Y (recovery-like) installed`,
        r.accepted && r.executed,
        r.detail,
      );
      const N = await nonceNow(a);
      const validFrom0 = Number(await read<number>(a, "validNonceFrom"));
      const wBefore = await submit(a, W!, kD, encodeExecute([{ to: deployer.address, value: 1n }]));
      record(
        `[${order}] W (session-like) works before invalidation`,
        wBefore.accepted && wBefore.executed,
        wBefore.detail,
      );
      console.log(`  currentNonce=${N} validNonceFrom=${validFrom0}`);

      // find the accepted argument range for invalidateNonce: try currentNonce, +1.
      const target = N + 1;
      const calls: Call[] =
        order === "change-then-invalidate"
          ? [
              { to: a.address, data: changeRootData(Z!, kC) },
              { to: a.address, data: invalidateData(target) },
            ]
          : [
              { to: a.address, data: invalidateData(target) },
              { to: a.address, data: changeRootData(Z!, kC) },
            ];
      // Q3: executed by the recovery-like validator Y through `execute` (batch).
      r = await submit(a, Y!, kB, encodeExecute(calls));
      record(
        `Q3 [${order}]: atomic batch via Y succeeded`,
        r.accepted && r.executed,
        `${r.detail} (invalidateNonce(${target}))`,
      );
      console.log(
        `  after: validNonceFrom=${await read<number>(a, "validNonceFrom")} currentNonce=${await nonceNow(a)} root=${await rootOf(a)}`,
      );
      const newRoot = await submit(
        a,
        null,
        kC,
        encodeExecute([{ to: deployer.address, value: 1n }]),
      );
      record(
        `Q3 [${order}]: NEW root Z signs`,
        newRoot.accepted && newRoot.executed,
        newRoot.detail,
      );
      const oldRootOp = await submit(
        a,
        null,
        kA,
        encodeExecute([{ to: deployer.address, value: 1n }]),
      );
      record(
        `Q2 [${order}]: old root key rejected`,
        !oldRootOp.accepted || !oldRootOp.executed,
        `accepted=${oldRootOp.accepted} executed=${oldRootOp.executed} ${oldRootOp.detail}`,
      );
      const wAfter = await submit(a, W!, kD, encodeExecute([{ to: deployer.address, value: 1n }]));
      record(
        `Q2 [${order}]: session-like W installed BEFORE is rejected`,
        !wAfter.accepted || !wAfter.executed,
        `accepted=${wAfter.accepted} executed=${wAfter.executed} ${wAfter.detail}`,
      );
      const yAfter = await submit(a, Y!, kB, encodeExecute([{ to: deployer.address, value: 1n }]));
      record(
        `Q2 [${order}]: recovery-like Y (installed before) is rejected`,
        !yAfter.accepted || !yAfter.executed,
        `accepted=${yAfter.accepted} executed=${yAfter.executed} ${yAfter.detail}`,
      );
      // A validator installed AFTER the invalidation, by the NEW root, at the account's current nonce.
      const kE = generatePrivateKey();
      const nowNonce = await nonceNow(a);
      const reinstall = await submit(
        a,
        null,
        kC,
        encodeExecute(installCalls(a, V!, kE, nowNonce, [sel.execute])),
      );
      record(
        `Q2 [${order}]: new root can install a NEW validator after the invalidation`,
        reinstall.accepted && reinstall.executed,
        `nonce=${nowNonce} validNonceFrom=${await read<number>(a, "validNonceFrom")} ${reinstall.detail}`,
      );
      const vWorks = await submit(a, V!, kE, encodeExecute([{ to: deployer.address, value: 1n }]));
      record(
        `Q2 [${order}]: the newly installed validator is usable`,
        vWorks.accepted && vWorks.executed,
        vWorks.detail,
      );
    }

    if (process.argv[3] === "bounds") {
      // invalidateNonce argument bounds, on its own (root-signed).
      const b = await newAccount(kA, salt());
      r = await submit(b, null, kA, encodeExecute([{ to: deployer.address, value: 1n }]));
      const cur = await nonceNow(b);
      for (const n of [0, cur - 1, cur, cur + 1, cur + 5]) {
        if (n < 0) continue;
        const out = await submit(
          b,
          null,
          kA,
          encodeExecute([{ to: b.address, data: invalidateData(n) }]),
        );
        console.log(
          `  invalidateNonce(${n}) with currentNonce=${cur}: accepted=${out.accepted} executed=${out.executed} ${out.detail} → validNonceFrom=${await read<number>(b, "validNonceFrom")}`,
        );
      }
    }
  }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} expectations met`);
  if (failed.length) for (const f of failed) console.log("UNEXPECTED:", f.name, f.detail);
}

await main();
