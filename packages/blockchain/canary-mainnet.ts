/*
 * Celo MAINNET canary for Kaada's production Kernel flow through Alchemy. Phases (each is a separate invocation):
 *   plan              no send. Fresh passkey + session key, prepares the ROOT op (estimates via Alchemy), prints costs.
 *   send-root         SENDS eth_sendUserOperation (root: deploy + install permission). Needs CANARY_APPROVED=root.
 *   estimate-delegated no send. Builds the delegated op and estimates it (send is blocked).
 *   send-delegated    SENDS the delegated op. Needs CANARY_APPROVED=delegated.
 * State (private keys!) lives OUTSIDE the repo: ~/.kaada-canary/state.json
 */
import { createSign, generateKeyPairSync, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { concat, createPublicClient, encodeFunctionData, erc20Abi, http, pad, toHex } from "viem";
import type { Address, Hex } from "viem";
import { toPackedUserOperation, entryPoint07Abi } from "viem/account-abstraction";
import { celo } from "viem/chains";

import { createMoney } from "@kaada/domain";
import { SecretValue } from "@kaada/domain";

import { createZeroDevKernelAdapter } from "./src/execution/zerodev-kernel-adapter.js";
import { createKernelAddressDeriver } from "./src/wallet/kernel-deriver.js";

const TAG_SUFFIX: Hex = "0x63656c6f5f353163346132616532323430110080218021802180218021802180218021"; // toDataSuffix("celo_51c4a2ae2240")
const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const CELO_ERC20: Address = "0x471EcE3750Da237f93B8E339c536989b8978a438";
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
const SDK = process.env["ATTR_SDK_DIR"]!; // scratchpad install of @celo/attribution-tags (verification only)

const url = process.env["BUNDLER_URL"]!;
const rpc = process.env["CELO_RPC_URL"];
const dir = join(homedir(), ".kaada-canary");
const statePath = join(dir, "state.json");
mkdirSync(dir, { recursive: true });
const state: Record<string, any> = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });

const redact = (s: string) =>
  s
    .split(url)
    .join("<BUNDLER_URL>")
    .replace(/\/v2\/[^"\s/?]+/g, "/v2/<redacted>")
    .replace(/(api[-_]?key|key|token)=[^"&\s]+/gi, "$1=<redacted>");
let allowSend = false;
const sentLog: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isBundler = target === url;
  const body = typeof init?.body === "string" ? init.body : undefined;
  if (isBundler && body) {
    const m = (JSON.parse(body) as { method: string }).method;
    if (/sendUserOperation/i.test(m) && !allowSend)
      throw new Error("GUARD: eth_sendUserOperation blocked in this phase");
    if (/sendUserOperation/i.test(m)) sentLog.push(m);
    console.log(`>>> ${m}`);
  }
  const res = await realFetch(input, init);
  if (isBundler)
    console.log(`<<< HTTP ${res.status} ${redact((await res.clone().text()).slice(0, 600))}`);
  return res;
}) as typeof fetch;

const client = createPublicClient({ chain: celo, transport: http(rpc) });
const adapter = createZeroDevKernelAdapter({
  bundlerUrl: url,
  rpcUrl: rpc,
  attributionSuffix: TAG_SUFFIX,
});

const reviveOp = (p: any) => p; // prepared op stays in its JSON-safe form
const unbig = (v: any): any =>
  typeof v === "string" && v.startsWith("bigint:")
    ? BigInt(v.slice(7))
    : Array.isArray(v)
      ? v.map(unbig)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unbig(x)]))
        : v;

function webauthnAssertion(privateKeyPem: string, challenge: Hex) {
  const authData = Buffer.concat([
    createHash("sha256").update("kaada.xyz").digest(),
    Buffer.from([0x05, 0, 0, 0, 1]),
  ]);
  const clientData = JSON.stringify({
    type: "webauthn.get",
    challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"),
    origin: "https://app.kaada.xyz",
    crossOrigin: false,
  });
  const signer = createSign("sha256");
  signer.update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]));
  const der = signer.sign(privateKeyPem); // DER, normalised by the adapter
  return {
    response: {
      authenticatorData: authData.toString("base64url"),
      clientDataJSON: Buffer.from(clientData).toString("base64url"),
      signature: der.toString("base64url"),
    },
  };
}

async function attributionCheck(op: any, signature: Hex) {
  const sdk = await import(
    pathToFileURL(join(SDK, "node_modules/@celo/attribution-tags/dist/index.js")).href
  );
  const packed = toPackedUserOperation({ ...unbig(op), signature });
  const input = encodeFunctionData({
    abi: entryPoint07Abi,
    functionName: "handleOps",
    args: [[packed], DEAD],
  });
  return sdk.fromEntryPointCalldata(input);
}

const phase = process.argv[2];

if (phase === "plan" || phase === "replan") {
  // replan: the SAME disposable account and passkey as the stored plan, with a fresh permission window and session key (the stored
  // permission expires after 24 h). Estimates only; the private signing key already in the state file is reused, never regenerated.
  const reuse = phase === "replan";
  if (reuse && !state["privateKeyPem"]) throw new Error("no stored plan to renew");
  const { publicKey, privateKey } = reuse
    ? { publicKey: undefined, privateKey: undefined }
    : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey?.export({ format: "jwk" }) ?? { x: undefined, y: undefined };
  const hex = (b?: string) => Buffer.from(b ?? "", "base64url").toString("hex");
  const credential = reuse
    ? (state["credential"] as never)
    : {
        type: "PASSKEY" as const,
        credentialId: Buffer.from(
          createHash("sha256")
            .update(jwk.x! + jwk.y!)
            .digest(),
        ).toString("base64url"),
        publicKeyX: hex(jwk.x),
        publicKeyY: hex(jwk.y),
        rpId: "kaada.xyz",
      };
  const wallet = (await createKernelAddressDeriver({ rpcUrl: rpc }).deriveAddress(
    credential,
  )) as Address;
  const now = Date.now();
  const scope = {
    chainId: 42220,
    allowedOperations: ["APPROVE_TOKEN"],
    allowedContracts: [CELO_ERC20, DEAD],
    allowedAssetIds: ["canary"],
    perTransactionLimit: createMoney("1", "canary"),
    approval: { tokenAddress: CELO_ERC20, spender: DEAD, limit: createMoney("1", "canary") },
    swapTarget: DEAD,
    swapSelector: "0xdeadbeef",
    validFrom: new Date(now - 60_000),
    expiresAt: new Date(now + 24 * 3600_000),
  };
  const prepared = await adapter.prepareRootOperation({
    walletAddress: wallet,
    credential,
    calls: [],
    permission: { scope },
  } as never);
  const op = prepared.prepared["userOperation"] as any;
  const o = unbig(op);
  const gasPrice = await client.getGasPrice();
  const gas = o.preVerificationGas + o.verificationGasLimit + o.callGasLimit;
  const tag = await attributionCheck(op, "0x");
  Object.assign(state, {
    wallet,
    credential,
    privateKeyPem: reuse
      ? state["privateKeyPem"]
      : privateKey!.export({ format: "pem", type: "pkcs8" }).toString(),
    sessionKey: prepared.sessionKey?.privateKey.reveal(),
    sessionKeyAddress: prepared.prepared["sessionKeyAddress"],
    scope: prepared.prepared["scope"],
    rootPrepared: prepared.prepared,
    rootChallenge: prepared.challenge,
    plannedAt: now,
  });
  save();
  console.log(
    JSON.stringify(
      {
        wallet,
        deployedAlready: await adapter.isDeployed(wallet),
        nonce: o.nonce.toString(),
        factory: op.factory,
        paymaster: op.paymaster ?? null,
        gas: {
          preVerificationGas: o.preVerificationGas.toString(),
          verificationGasLimit: o.verificationGasLimit.toString(),
          callGasLimit: o.callGasLimit.toString(),
          total: gas.toString(),
        },
        maxFeePerGas: o.maxFeePerGas.toString(),
        currentGasPrice: gasPrice.toString(),
        rootPrefundMaxWei: (gas * o.maxFeePerGas).toString(),
        rootLikelyCostWei: (gas * gasPrice).toString(),
        attributionOffline: tag,
        rootHash: prepared.challenge,
        sessionKeyAddress: prepared.prepared["sessionKeyAddress"],
      },
      null,
      2,
    ),
  );
} else if (phase === "send-root") {
  if (process.env["CANARY_APPROVED"] !== "root") throw new Error("not approved");
  allowSend = true;
  const assertion = webauthnAssertion(state["privateKeyPem"], state["rootChallenge"]);
  const sent = await adapter.sendRootOperation({
    prepared: state["rootPrepared"],
    proof: { type: "PASSKEY", assertion } as never,
  });
  state["rootUserOpHash"] = sent.userOpHash;
  state["approval"] = sent.approval?.reveal();
  save();
  console.log("ROOT userOpHash:", sent.userOpHash, "sent:", sentLog);
} else if (phase === "estimate-delegated" || phase === "send-delegated") {
  const send = phase === "send-delegated";
  if (send && process.env["CANARY_APPROVED"] !== "delegated") throw new Error("not approved");
  allowSend = send;
  const calls = [
    {
      to: CELO_ERC20,
      value: "0",
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DEAD, 0n] }),
    },
  ];
  try {
    const r = await adapter.sendDelegatedCalls({
      walletAddress: state["wallet"],
      sessionKey: new SecretValue(state["sessionKey"]),
      approval: new SecretValue(state["approval"]),
      calls,
      beforeSubmit: (h: string) => {
        if (send) {
          console.log("DELEGATED signed; userOpHash", h);
          state["delegatedUserOpHash"] = h;
          save();
        }
      },
    } as never);
    console.log("DELEGATED sent:", r.userOpHash);
  } catch (e) {
    console.log(
      "DELEGATED result:",
      redact(String((e as any)?.details ?? (e as any)?.message)),
      "| sent:",
      sentLog,
    );
  }
} else if (phase === "receipt") {
  const h = (process.argv[3] as Hex) ?? state["rootUserOpHash"];
  console.log(JSON.stringify(await adapter.getUserOperationReceipt(h)));
} else throw new Error("phase?");
void toHex;
void pad;
void concat;
void reviveOp;
