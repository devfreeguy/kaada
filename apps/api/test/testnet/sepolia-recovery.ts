/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- a testnet harness reading untyped JSON from its own API */
/*
 * ACCOUNT RECOVERY through the REAL Kaada API on Celo SEPOLIA. TESTNET ONLY.
 *
 *   KAADA_HARNESS_STATE=<state.json> BUNDLER_URL_TESTNET=http://localhost:4337 \
 *     node --import tsx test/testnet/sepolia-recovery.ts
 *
 * It boots the production AppModule (the real controller, services, repositories, Postgres, recovery chain adapter, attestor
 * key and the SHORT-DELAY test build of KaadaRecoveryValidator through the local Alto bundler), then plays the person with
 * plain HTTP calls and software authenticators. Nothing about recovery is stubbed:
 *
 *   A. passkey root  -> device-key root   (email, Recovery Code, attestor, 25 s delay, finalize, proof, PIN, new Recovery Code)
 *   B. device root   -> passkey root       (a real WebAuthn registration on the new device, verified by SimpleWebAuthn)
 *   C. passkey root, recovery CANCELLED by the existing root through the cancel link
 *   D. device root, recovery VETOED by the attestor through the report link
 *
 * The short delay lives only in the test deployment of the validator; the production contract and the production
 * configuration refuse anything below 24 hours. Secrets (keys, the email outbox) live OUTSIDE the repository.
 */
import "reflect-metadata";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Database } from "@kaada/database";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const statePath = process.env["KAADA_HARNESS_STATE"];
if (!statePath) throw new Error("KAADA_HARNESS_STATE is required");
interface State {
  deployerKey: `0x${string}`;
  validator: string;
  passkeyFactory: { address: string };
  deviceKey: { implementation: string; factory: string };
  recoveryProbe: { registry: string; validator: string };
}
const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
const workDir = dirname(statePath);
const SEPOLIA_RPC = "https://forno.celo-sepolia.celo-testnet.org";
const CHAIN_ID = 11142220;
const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";
const bundlerUrl = process.env["BUNDLER_URL_TESTNET"];
if (!bundlerUrl || !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(bundlerUrl)) {
  throw new Error("BUNDLER_URL_TESTNET must point at the LOCAL Alto bundler");
}

// ── keys and the outbox live next to the state file, outside the repository ──
const keyFile = (name: string, make: () => string) => {
  const path = `${workDir}/${name}`;
  if (!existsSync(path)) writeFileSync(path, make(), { mode: 0o600 });
  return path;
};
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const relayerKeyFile = keyFile("recovery-relayer.key", () => state.deployerKey);
const attestorKeyFile = keyFile("recovery-attestor.key", () => generatePrivateKey());
const outboxFile = `${workDir}/recovery-outbox.jsonl`;
mkdirSync(workDir, { recursive: true });
writeFileSync(outboxFile, "", { mode: 0o600 });

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}
Object.assign(process.env, {
  NODE_ENV: "development",
  WALLET_PROVIDER: "kernel",
  PASSKEY_RP_ID: RP_ID,
  PASSKEY_ORIGIN: ORIGIN,
  AGENT_INTERPRETER: "none",
  FX_PROVIDER: "none",
  EXECUTION_ENABLED: "false",
  EXECUTION_SECRET_KEY: randomBytes(32).toString("base64"),
  LOG_LEVEL: "warn",
  CELO_RPC_URL: SEPOLIA_RPC,
  BUNDLER_URL: bundlerUrl,
  RECOVERY_ENABLED: "true",
  RECOVERY_CHAIN_ID: String(CHAIN_ID),
  RECOVERY_VALIDATOR_ADDRESS: state.recoveryProbe.validator,
  RECOVERY_PASSKEY_FACTORY_ADDRESS: state.passkeyFactory.address,
  RECOVERY_PASSKEY_IMPLEMENTATION_ADDRESS: state.validator,
  RECOVERY_DEVICE_FACTORY_ADDRESS: state.deviceKey.factory,
  RECOVERY_DEVICE_IMPLEMENTATION_ADDRESS: state.deviceKey.implementation,
  RECOVERY_RELAYER_KEY_FILE: relayerKeyFile,
  RECOVERY_ATTESTOR_KEY_FILE: attestorKeyFile,
  RECOVERY_CHALLENGE_SECRET: randomBytes(32).toString("base64"),
  RECOVERY_EMAIL_PROVIDER: "outbox",
  RECOVERY_EMAIL_OUTBOX_FILE: outboxFile,
  // TEST-ONLY short delay: the validator under test is the short-delay build; production keeps the 24 h floor.
  RECOVERY_DELAY_SECONDS: "25",
  RECOVERY_MIN_DELAY_SECONDS: "10",
  RECOVERY_SWEEP_INTERVAL_SECONDS: "0",
  RECOVERY_GAS_TOPUP_MAX_WEI: "300000000000000000",
});

const [
  { Test },
  { FastifyAdapter },
  contracts,
  blockchain,
  database,
  domain,
  { AppModule },
  { configureApp },
  { DATABASE },
  viem,
  { celoSepolia },
  { createSoftwareAuthenticator },
  { RECOVERY_RUNTIME },
] = await Promise.all([
  import("@nestjs/testing"),
  import("@nestjs/platform-fastify"),
  import("@kaada/contracts"),
  import("@kaada/blockchain"),
  import("@kaada/database"),
  import("@kaada/domain"),
  import("../../src/app.module.js"),
  import("../../src/app.setup.js"),
  import("../../src/database/database.module.js"),
  import("viem"),
  import("viem/chains"),
  import("../support/software-authenticator.js"),
  import("../../src/recovery/recovery.tokens.js"),
]);
type Hex = `0x${string}`;
type Db = Database;

const results: { name: string; pass: boolean; detail: string }[] = [];
const record = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the application ─────────────────────────────────────────────────────────────────────────────
const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
const { APP_CONFIG } = await import("../../src/config/config.module.js");
configureApp(app, moduleRef.get(APP_CONFIG));
await app.init();
await app.listen(0, "127.0.0.1");
const baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
const db = moduleRef.get<Db>(DATABASE);
const repos = database.createRepositories(db);
const runtime = moduleRef.get(RECOVERY_RUNTIME);
if (!runtime) throw new Error("recovery is not enabled in the composed application");
console.log("API listening at", baseUrl);

// ── Sepolia plumbing (the person's world: accounts and clones are created by the test, not by Kaada) ──
const pub = viem.createPublicClient({ chain: celoSepolia, transport: viem.http(SEPOLIA_RPC) });
const deployer = privateKeyToAccount(state.deployerKey);
const wallet = viem.createWalletClient({
  account: deployer,
  chain: celoSepolia,
  transport: viem.http(SEPOLIA_RPC),
});
const KERNEL_FACTORY = "0x2577507b78c2008Ff367261CB6285d44ba5eF2E9" as const;
const kernelFactoryAbi = viem.parseAbi([
  "function createAccount(bytes data, bytes32 salt) payable returns (address)",
  "function getAddress(bytes data, bytes32 salt) view returns (address)",
]);
const factoryAbi = contracts.artifacts.KaadaPasskeyValidatorFactory.abi;
const registryAbi = contracts.artifacts.MockAttestorRegistry.abi;
const KernelV3_3AccountAbi = viem.parseAbi([
  "function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)",
  "function installValidations(bytes21[] vIds, (uint32 nonce, address hook)[] configs, bytes[] validationData, bytes[] hookData)",
  "function grantAccess(bytes21 vId, bytes4 selector, bool allow)",
]);
const deployments = {
  passkey: { factory: state.passkeyFactory.address as Hex, implementation: state.validator as Hex },
  device: {
    factory: state.deviceKey.factory as Hex,
    implementation: state.deviceKey.implementation as Hex,
  },
};
const chain = new blockchain.ViemRecoveryChain({
  chain: celoSepolia,
  rpcUrl: SEPOLIA_RPC,
  bundlerUrl,
  recoveryValidator: state.recoveryProbe.validator as Hex,
  deployments,
  relayerKey: state.deployerKey,
  p256Precompile: true,
  gasSponsor: { mode: "topup", maxTopUpWei: 300_000_000_000_000_000n },
});
const attestorAddress = privateKeyToAccount(
  readFileSync(attestorKeyFile, "utf8").trim() as Hex,
).address;

async function send(request: Parameters<typeof wallet.writeContract>[0]): Promise<Hex> {
  const hash = await wallet.writeContract(request);
  await pub.waitForTransactionReceipt({ hash });
  await sleep(3_000);
  return hash;
}

async function prepareAttestor(): Promise<void> {
  await send({
    address: state.recoveryProbe.registry as Hex,
    abi: registryAbi,
    functionName: "setAttestor",
    args: [attestorAddress],
    chain: celoSepolia,
    account: deployer,
  });
  const balance = await pub.getBalance({ address: attestorAddress });
  if (balance < 150_000_000_000_000_000n) {
    const hash = await wallet.sendTransaction({
      to: attestorAddress,
      value: 200_000_000_000_000_000n,
    });
    await pub.waitForTransactionReceipt({ hash });
  }
}
await prepareAttestor();
console.log("attestor", attestorAddress);

// ── clients: software passkey and a raw P-256 device key ──
interface Credential {
  kind: "PASSKEY" | "DEVICE_KEY";
  /** passkey: credential id (base64url); device: keyId */
  ref: string;
  x: string;
  y: string;
  sign(userOpHash: Hex, validator: Hex, account: Hex): unknown;
}

function newPasskey(): Credential & {
  authenticator: ReturnType<typeof createSoftwareAuthenticator>;
} {
  const authenticator = createSoftwareAuthenticator();
  let counter = 0;
  return {
    kind: "PASSKEY",
    ref: authenticator.credentialId,
    x: authenticator.x,
    y: authenticator.y,
    authenticator,
    sign: (hash) => {
      counter += 1;
      return authenticator.authenticate({
        challenge: Buffer.from(hash.slice(2), "hex").toString("base64url"),
        origin: ORIGIN,
        rpId: RP_ID,
        counter,
      });
    },
  };
}

function newDeviceKey(): Credential {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x ?? "", "base64url").toString("hex");
  const y = Buffer.from(jwk.y ?? "", "base64url").toString("hex");
  const keyId = contracts.deviceKeyIdFromPoint({ x: BigInt(`0x${x}`), y: BigInt(`0x${y}`) });
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  return {
    kind: "DEVICE_KEY",
    ref: keyId,
    x,
    y,
    sign: (userOpHash, validator, account) => {
      const payload = contracts.deviceKeyPayload({
        chainId: CHAIN_ID,
        validator,
        account,
        keyId,
        userOpHash,
      });
      const raw = sign("sha256", Buffer.from(payload.slice(2), "hex"), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      });
      const r = BigInt(viem.bytesToHex(raw.subarray(0, 32)));
      let s = BigInt(viem.bytesToHex(raw.subarray(32)));
      if (s > N / 2n) s = N - s;
      return viem.concat([
        keyId,
        viem.pad(viem.toHex(r), { size: 32 }),
        viem.pad(viem.toHex(s), { size: 32 }),
      ]);
    },
  };
}

/** Creates the account with `credential` as its creation-time root (a fresh clone), funded, deployed, and recorded in the DB. */
async function createWorld(credential: Credential, label: string) {
  const salt = viem.keccak256(viem.toHex(`${label}:${randomUUID()}`));
  const factoryCredential = contracts.toFactoryCredential(
    credential.kind === "PASSKEY"
      ? {
          kind: "PASSKEY",
          credentialId: credential.ref,
          publicKeyX: credential.x,
          publicKeyY: credential.y,
        }
      : {
          kind: "DEVICE_KEY",
          keyId: credential.ref as Hex,
          publicKeyX: credential.x,
          publicKeyY: credential.y,
        },
  );
  const deployment = credential.kind === "PASSKEY" ? deployments.passkey : deployments.device;
  const instance = contracts.predictPasskeyInstance(deployment.factory, deployment.implementation, {
    scope: viem.zeroAddress,
    purpose: contracts.PASSKEY_PURPOSE.PRIMARY,
    credential: factoryCredential,
    deploymentSalt: salt,
  });
  await send({
    address: deployment.factory,
    abi: factoryAbi,
    functionName: "deploy",
    args: [
      viem.zeroAddress,
      contracts.PASSKEY_PURPOSE.PRIMARY,
      contracts.passkeyCredentialCommitment(factoryCredential),
      salt,
    ],
    chain: celoSepolia,
    account: deployer,
    gas: 400_000n,
  });
  const rootData =
    credential.kind === "PASSKEY"
      ? contracts.passkeyInstallData(factoryCredential)
      : contracts.deviceKeyInstallData(
          { x: factoryCredential.x, y: factoryCredential.y },
          credential.ref as Hex,
        );
  const initData = viem.encodeFunctionData({
    abi: KernelV3_3AccountAbi,
    functionName: "initialize",
    args: [viem.concat(["0x01", instance]), viem.zeroAddress, rootData, "0x", []],
  });
  const kernelSalt = viem.keccak256(viem.toHex(randomUUID()));
  const account = await pub.readContract({
    address: KERNEL_FACTORY,
    abi: kernelFactoryAbi,
    functionName: "getAddress",
    args: [initData, kernelSalt],
  });
  await send({
    address: KERNEL_FACTORY,
    abi: kernelFactoryAbi,
    functionName: "createAccount",
    args: [initData, kernelSalt],
    chain: celoSepolia,
    account: deployer,
    gas: 2_000_000n,
  });
  const fund = await wallet.sendTransaction({ to: account, value: 120_000_000_000_000_000n });
  await pub.waitForTransactionReceipt({ hash: fund });
  await sleep(3_000);

  // ── the database: a user with an email, an ACTIVE wallet at that account, the root credential, a PIN ──
  const userId = randomUUID();
  const email = `${label}.${randomBytes(4).toString("hex")}@example.com`;
  await repos.users.create({ id: userId });
  await repos.identities.add({ id: randomUUID(), userId, type: "EMAIL", externalId: email });
  const created = await repos.wallets.create({
    id: randomUUID(),
    userId,
    chainId: 42220,
    isPrimary: true,
    type: "EMBEDDED",
    status: "PROVISIONING",
    deployment: "NOT_APPLICABLE",
  });
  const active = await repos.wallets.activate(created.id, {
    address: account.toLowerCase(),
    deployment: "DEPLOYED",
    provider: "zerodev-kernel-v3.3",
    at: new Date(),
  });
  if (!active) throw new Error("wallet activation failed");
  let passkeyRowId: string | undefined;
  if (credential.kind === "PASSKEY") {
    passkeyRowId = randomUUID();
    await repos.passkeys.create({
      id: passkeyRowId,
      userId,
      credentialId: credential.ref,
      publicKeyX: credential.x,
      publicKeyY: credential.y,
      rpId: RP_ID,
    });
  }
  await repos.walletCredentials.create({
    id: randomUUID(),
    userId,
    walletId: active.id,
    kind: credential.kind,
    role: "PRIMARY",
    status: "ACTIVE",
    isRoot: true,
    validatorAddress: instance.toLowerCase(),
    validatorPurpose: 0,
    deploymentSalt: salt,
    credentialRef: credential.ref,
    publicKeyX: credential.x,
    publicKeyY: credential.y,
    ...(credential.kind === "PASSKEY" && { rpId: RP_ID, passkeyCredentialId: passkeyRowId }),
    securityTier: "UNKNOWN",
  } as never);
  await repos.transactionPins.create({
    id: randomUUID(),
    userId,
    pinHash: "$argon2id$placeholder-for-test",
    now: new Date(),
  });
  await db.client.session.create({
    data: {
      id: randomUUID(),
      userId,
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  // A delegated permission with encrypted secrets, to see them retired.
  const asset = (await repos.assets.listActive())[0];
  const sessionSecret = randomUUID();
  const approvalSecret = randomUUID();
  for (const id of [sessionSecret, approvalSecret]) {
    await repos.executionSecrets.put({
      id,
      purpose: "SESSION_KEY",
      keyVersion: 1,
      ciphertext: "v1.abc.def",
      now: new Date(),
    });
  }
  const permissionId = randomUUID();
  if (asset) {
    await repos.delegatedPermissions.create({
      id: permissionId,
      userId,
      walletId: active.id,
      provider: "zerodev-kernel-v3.3",
      chainId: 42220,
      status: "PENDING",
      allowedOperations: ["TRANSFER_TOKEN"],
      allowedContracts: ["0x00000000000000000000000000000000000000aa"],
      allowedAssetIds: [asset.id],
      perTransactionLimit: { amount: "100", assetId: asset.id },
      enforcement: blockchain.KERNEL_ENFORCEMENT,
      validFrom: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 86_400_000),
    } as never);
    await repos.delegatedPermissions.attachSessionKey(permissionId, {
      address: "0x00000000000000000000000000000000000000bb",
      sessionKeySecretId: sessionSecret,
      approvalSecretId: approvalSecret,
    });
  }
  // A wallet setup link (the first-time identity for arming a Recovery Code).
  const setupToken = randomBytes(32).toString("base64url");
  await repos.walletSetupSessions.create({
    id: randomUUID(),
    userId,
    tokenHash: createHash("sha256").update(setupToken).digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return {
    userId,
    email,
    account,
    walletId: active.id,
    instance,
    credential,
    setupToken,
    permissionId,
    sessionSecret,
  };
}
type World = Awaited<ReturnType<typeof createWorld>>;

// ── HTTP ──
async function api(
  method: "GET" | "POST",
  path: string,
  options: { token?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}/api/v1/recovery${path}`, {
    method,
    headers: {
      ...(options.token && { authorization: `Bearer ${options.token}` }),
      ...(options.body !== undefined && { "content-type": "application/json" }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
function emailCode(to: string): string {
  const lines = readFileSync(outboxFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { to: string; text: string });
  const mail = [...lines]
    .reverse()
    .find((m) => m.to === to && /verification code is \d{6}/.test(m.text));
  const code = /verification code is (\d{6})/.exec(mail?.text ?? "")?.[1];
  if (!code) throw new Error(`no code for ${to}`);
  return code;
}
function reportToken(to: string): string {
  const lines = readFileSync(outboxFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { to: string; text: string });
  const mail = [...lines]
    .reverse()
    .find((m) => m.to === to && m.text.includes("/recovery/report#"));
  const token = /\/recovery\/report#([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "")?.[1];
  if (!token) throw new Error(`no report link for ${to}`);
  return token;
}

/** Signs a prepared root operation request the way the root's device would. */
function rootMaterial(
  world: World,
  request: Record<string, any>,
  root: Credential,
  rootValidator: Hex,
): unknown {
  return root.sign(request["challenge"] as Hex, rootValidator, world.account);
}

async function currentRoot(world: World): Promise<Hex> {
  return (await chain.accountState(world.account)).rootValidator as Hex;
}

/** Arms a Recovery Code through the API with the wallet setup link, signed by the CURRENT root. */
async function armRecovery(
  world: World,
  code: InstanceType<typeof contracts.RecoveryCode>,
  token: string,
  root: Credential,
  rootValidator: Hex,
) {
  const verifier = contracts.deriveRecoveryKey(code, {
    chainId: CHAIN_ID,
    account: world.account,
  });
  const prepared = await api("POST", "/configuration/prepare", {
    token,
    body: { recoveryAddress: verifier.address, delaySeconds: 25 },
  });
  if (prepared.status !== 200)
    throw new Error(
      `arm prepare failed ${String(prepared.status)} ${JSON.stringify(prepared.body)}`,
    );
  const signing = prepared.body["signing"] as Record<string, any>;
  const submitted = await api("POST", "/configuration", {
    token,
    body: {
      configurationId: prepared.body["configurationId"],
      material: rootMaterial(world, signing, root, rootValidator),
    },
  });
  return { verifier, prepared, submitted };
}

async function startVerified(world: World): Promise<string> {
  const start = await api("POST", "/start", { body: { email: world.email } });
  const token = String(start.body["token"]);
  await sleep(500);
  const verified = await api("POST", "/verify-email", {
    token,
    body: { code: emailCode(world.email) },
  });
  if (verified.status !== 200) throw new Error(`verify failed ${String(verified.status)}`);
  return token;
}

/** The new device registers a credential, the person types the Recovery Code, and the API starts the recovery. */
async function proposeAndProve(
  world: World,
  token: string,
  code: InstanceType<typeof contracts.RecoveryCode>,
  next: Credential,
) {
  let proposal;
  if (next.kind === "DEVICE_KEY") {
    proposal = await api("POST", "/root/device-key", {
      token,
      body: { publicKeyX: next.x, publicKeyY: next.y },
    });
  } else {
    const options = await api("POST", "/passkey/options", { token });
    const registration = (next as ReturnType<typeof newPasskey>).authenticator.register({
      challenge: String(options.body["challenge"]),
      origin: ORIGIN,
      rpId: RP_ID,
    });
    proposal = await api("POST", "/root/passkey", { token, body: { response: registration } });
  }
  if (proposal.status !== 200)
    throw new Error(`proposal failed ${String(proposal.status)} ${JSON.stringify(proposal.body)}`);
  const typed = proposal.body["typedData"] as {
    domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
    types: Record<string, { name: string; type: string }[]>;
    message: Record<string, string>;
  };
  const { privateKey } = contracts.deriveRecoveryKey(code, {
    chainId: CHAIN_ID,
    account: world.account,
  });
  const signature = await privateKeyToAccount(privateKey).signTypedData({
    domain: contracts.recoveryDomain(typed.domain.chainId, typed.domain.verifyingContract),
    types: contracts.recoveryInitiateTypes,
    primaryType: "Initiate",
    message: {
      account: typed.message["account"] as Hex,
      nonce: BigInt(typed.message["nonce"] ?? "0"),
      rootId: typed.message["rootId"] as Hex,
      hook: typed.message["hook"] as Hex,
      validatorDataHash: typed.message["validatorDataHash"] as Hex,
      hookDataHash: typed.message["hookDataHash"] as Hex,
      deadline: BigInt(typed.message["deadline"] ?? "0"),
    },
  });
  const proof = await api("POST", "/proof", { token, body: { signature } });
  return { proposal, proof, signature };
}

const only = new Set(
  (process.env["SCENARIOS"] ?? "A,B,C,D").split(",").map((s) => s.trim().toUpperCase()),
);
const created: World[] = [];
const cleanups: (() => Promise<void>)[] = [];

async function finalizeUntil(token: string, wanted: string, label: string): Promise<boolean> {
  for (let i = 0; i < 40; i += 1) {
    const r = await api("POST", "/finalize", { token });
    if (r.body["outcome"] === wanted) return true;
    if (["FAILED", "STOPPED"].includes(String(r.body["outcome"]))) {
      console.log(`  ${label}: finalize says`, JSON.stringify(r.body));
      return false;
    }
    await sleep(4_000);
  }
  return false;
}

try {
  // ═══════════════════════════ A. passkey root -> device-key root ═══════════════════════════
  if (only.has("A")) {
    console.log("\n── A. passkey root -> device-key root (full flow) ──");
    const rootA = newPasskey();
    const worldA = await createWorld(rootA, "a");
    created.push(worldA);
    const rootValidatorA = await currentRoot(worldA);
    record(
      "wallet A exists on Sepolia with a passkey-clone root",
      rootValidatorA.toLowerCase() === worldA.instance.toLowerCase(),
      worldA.account,
    );

    // first-time arming through the API (wallet setup link identifies the user; the CURRENT root passkey signs)
    const codeA = contracts.generateRecoveryCode();
    const armA = await armRecovery(worldA, codeA, worldA.setupToken, rootA, rootValidatorA);
    record(
      "Recovery Code armed through the API: the passkey root signed the install operation",
      armA.submitted.status === 200 && armA.submitted.body["status"] === "ACTIVE",
      JSON.stringify(armA.submitted.body),
    );
    const armed = await chain.validatorState(worldA.account);
    record(
      "the chain shows exactly the verifier derived from the Recovery Code (the code itself never left the client)",
      armed.initialized &&
        armed.recoveryKey === armA.verifier.address.toLowerCase() &&
        armed.delaySeconds === 25,
      armed.recoveryKey ?? "",
    );

    // a session-like validator W (an ECDSA lane) installed by the root, to see it voided
    const ECDSA_X = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57" as const;
    const sessionKey = generatePrivateKey();
    const wLane = viem.concat(["0x01", ECDSA_X]);
    const currentNonce = (await chain.accountState(worldA.account)).currentNonce;
    const install = await chain.prepareRootOperation({
      account: worldA.account,
      rootValidator: rootValidatorA,
      rootKind: "PASSKEY",
      calls: [
        {
          to: worldA.account,
          data: viem.encodeFunctionData({
            abi: KernelV3_3AccountAbi,
            functionName: "installValidations",
            args: [
              [wLane],
              [{ nonce: currentNonce, hook: viem.zeroAddress }],
              [privateKeyToAccount(sessionKey).address],
              ["0x"],
            ],
          }),
        },
        {
          to: worldA.account,
          data: viem.encodeFunctionData({
            abi: KernelV3_3AccountAbi,
            functionName: "grantAccess",
            args: [wLane, viem.toFunctionSelector("execute(bytes32,bytes)"), true],
          }),
        },
      ],
    });
    await chain.submitOperation({
      operation: install.operation,
      signature: chain.encodeRootSignature({
        kind: "PASSKEY",
        material: rootA.sign(install.userOpHash as Hex, rootValidatorA, worldA.account),
      }),
    });
    for (
      let i = 0;
      i < 20 && (await chain.operationStatus(install.userOpHash)).state !== "INCLUDED";
      i += 1
    )
      await sleep(3_000);
    let wInstalled = false;
    for (let i = 0; i < 15 && !wInstalled; i += 1) {
      wInstalled = !(await chain.laneVoided(worldA.account, wLane));
      if (!wInstalled) await sleep(2_000);
    }
    record("a session-like validator lane W is installed under the old root", wInstalled, "");

    // the recovery
    const nextA = newDeviceKey();
    const startA = await startVerified(worldA);
    const statusA = await api("GET", "/status", { token: startA });
    record(
      "email verified over HTTP; the verifier is shown so the page can check the typed code",
      statusA.body["status"] === "EMAIL_VERIFIED" &&
        statusA.body["recoveryAddress"] === armA.verifier.address.toLowerCase(),
      "",
    );
    const { proposal: propA, proof: proofA } = await proposeAndProve(worldA, startA, codeA, nextA);
    record(
      "recovery committed on chain: exact root, Recovery Code signature, attestor signature",
      proofA.status === 200 && proofA.body["status"] === "PENDING",
      JSON.stringify(proofA.body),
    );
    const pendingA = await chain.validatorState(worldA.account);
    const attemptA = await repos.recoveryAttempts.findActiveByWallet(worldA.walletId);
    record(
      "on-chain pending commitment equals the stored commitment",
      pendingA.pending?.commitment.toLowerCase() === attemptA?.commitmentHash?.toLowerCase(),
      attemptA?.commitmentHash ?? "",
    );
    record(
      "the new validator instance is a fresh clone deployed at the committed address",
      (await chain.instanceStatus({
        account: worldA.account,
        root: chain.proposeRoot({
          account: worldA.account,
          credential: {
            kind: "DEVICE_KEY",
            keyId: nextA.ref,
            publicKeyX: nextA.x,
            publicKeyY: nextA.y,
          },
          attemptId: attemptA?.id ?? "",
        }),
      })) === "DEPLOYED_UNUSED",
      propA.body["root"]?.validator,
    );
    const early = await api("POST", "/finalize", { token: startA });
    record(
      "finalize before maturity does nothing",
      early.body["outcome"] === "NOT_ELIGIBLE",
      JSON.stringify(early.body),
    );
    record(
      "every linked channel was told, with the report link",
      (() => {
        try {
          reportToken(worldA.email);
          return true;
        } catch {
          return false;
        }
      })(),
      "",
    );
    await sleep(30_000);
    const finalizedA = await finalizeUntil(startA, "ROOT_CHANGED", "A");
    record(
      "finalized through Alto: the exact atomic batch ran and the chain confirms the new root",
      finalizedA &&
        (await currentRoot(worldA)).toLowerCase() ===
          String(propA.body["root"]?.validator).toLowerCase(),
      "",
    );
    const afterA = await chain.accountState(worldA.account);
    record(
      "the Kernel nonce advanced (invalidateNonce was part of the batch)",
      afterA.currentNonce === currentNonce + 1 || afterA.currentNonce > currentNonce,
      String(afterA.currentNonce),
    );
    record(
      "the old root lane and the W lane are void on chain",
      (await chain.laneVoided(worldA.account, viem.concat(["0x01", rootValidatorA]))) &&
        (await chain.laneVoided(worldA.account, wLane)),
      "",
    );
    record(
      "the wallet address never changed",
      (await pub.getCode({ address: worldA.account }))?.length !== 2,
      worldA.account,
    );
    // the OLD passkey is refused by the chain
    const probe = await chain.prepareRootOperation({
      account: worldA.account,
      rootValidator: await currentRoot(worldA),
      rootKind: "PASSKEY",
      calls: chain.cancelCalls(),
    });
    let oldRefused = false;
    try {
      await chain.submitOperation({
        operation: probe.operation,
        signature: chain.encodeRootSignature({
          kind: "PASSKEY",
          material: rootA.sign(probe.userOpHash as Hex, rootValidatorA, worldA.account),
        }),
      });
    } catch (error) {
      oldRefused = domain.isKaadaError(error, "BUNDLER_REJECTED");
    }
    record("the OLD passkey root is rejected by the chain", oldRefused, "");
    record(
      "the old session lane W is void (above); its permission is revoked and its secrets destroyed",
      (await repos.delegatedPermissions.findById(worldA.permissionId))?.status === "REVOKED" &&
        (await repos.executionSecrets.get(worldA.sessionSecret)) === null,
      "",
    );
    record(
      "old sessions are retired in the database (web session, setup link, PIN locked)",
      (await db.client.session.count({ where: { userId: worldA.userId, revokedAt: null } })) ===
        0 &&
        (
          await repos.walletSetupSessions.findByTokenHash(
            createHash("sha256").update(worldA.setupToken).digest("hex"),
          )
        )?.status === "REVOKED" &&
        (await repos.transactionPins.findByUserId(worldA.userId))?.resetRequired === true,
      "",
    );
    const oldRows = await repos.walletCredentials.listForWallet(worldA.walletId);
    record(
      "the old credential is REPLACED and the new one is the ACTIVE root",
      oldRows.filter((c) => c.status === "REPLACED").length === 1 &&
        oldRows.find((c) => c.isRoot)?.kind === "DEVICE_KEY",
      "",
    );
    record(
      "the old Recovery Code is spent on chain (it can never be installed again)",
      !(await chain.validatorState(worldA.account)).initialized,
      "",
    );

    // the new credential proves it can sign
    const proofOptionsA = await api("POST", "/signing-proof/options", { token: startA });
    const validatorA = String(propA.body["root"]?.validator) as Hex;
    const badProof = await api("POST", "/signing-proof", {
      token: startA,
      body: {
        material: rootA.sign(
          proofOptionsA.body["challenge"] as Hex,
          rootValidatorA,
          worldA.account,
        ),
      },
    });
    record(
      "a signature from the old credential does NOT prove the new one",
      badProof.status === 400,
      String(badProof.status),
    );
    const goodProof = await api("POST", "/signing-proof", {
      token: startA,
      body: {
        material: nextA.sign(proofOptionsA.body["challenge"] as Hex, validatorA, worldA.account),
      },
    });
    record(
      "the NEW device key signs the challenge; the validator on chain accepts it; the recovery is COMPLETED",
      goodProof.status === 200 && goodProof.body["status"] === "COMPLETED",
      JSON.stringify(goodProof.body),
    );
    const pinA = await api("POST", "/pin", { token: startA, body: { pin: "2468" } });
    record(
      "PIN reset through the verified recovery session",
      pinA.status === 200 && pinA.body["nextStep"] === "CREATE_RECOVERY_CODE",
      JSON.stringify(pinA.body),
    );
    record(
      "the old PIN row was replaced and no longer needs a reset",
      (await repos.transactionPins.findByUserId(worldA.userId))?.resetRequired === false,
      "",
    );

    // a NEW Recovery Code, armed by the NEW root
    const newCodeA = contracts.generateRecoveryCode();
    const rearmA = await armRecovery(worldA, newCodeA, startA, nextA, validatorA);
    record(
      "a NEW Recovery Code is armed by the new device-key root",
      rearmA.submitted.status === 200 && rearmA.submitted.body["status"] === "ACTIVE",
      JSON.stringify(rearmA.submitted.body),
    );
    const rearmed = await chain.validatorState(worldA.account);
    record(
      "the chain shows the NEW verifier and not the old one",
      rearmed.recoveryKey === rearmA.verifier.address.toLowerCase() &&
        rearmed.recoveryKey !== armA.verifier.address.toLowerCase(),
      "",
    );
    record(
      "the recovery status is DONE",
      (await api("GET", "/status", { token: startA })).body["nextStep"] === "DONE",
      "",
    );
  }
  if (only.has("B")) {
    console.log("\n── B. device-key root -> passkey root ──");
    const rootB = newDeviceKey();
    const worldB = await createWorld(rootB, "b");
    created.push(worldB);
    const rootValidatorB = await currentRoot(worldB);
    const codeB = contracts.generateRecoveryCode();
    const armB = await armRecovery(worldB, codeB, worldB.setupToken, rootB, rootValidatorB);
    record(
      "B: Recovery Code armed through the API, signed by the DEVICE-KEY root",
      armB.submitted.status === 200 && armB.submitted.body["status"] === "ACTIVE",
      JSON.stringify(armB.submitted.body),
    );
    const nextB = newPasskey();
    const tokenB = await startVerified(worldB);
    const { proposal: propB, proof: proofB } = await proposeAndProve(worldB, tokenB, codeB, nextB);
    record(
      "B: a real WebAuthn registration on the new device was verified and the recovery committed",
      propB.status === 200 && proofB.body["status"] === "PENDING",
      JSON.stringify(proofB.body),
    );
    await sleep(30_000);
    const finalizedB = await finalizeUntil(tokenB, "ROOT_CHANGED", "B");
    const validatorB = String(propB.body["root"]?.validator) as Hex;
    record(
      "B: finalized; the chain confirms the passkey clone as root",
      finalizedB && (await currentRoot(worldB)).toLowerCase() === validatorB.toLowerCase(),
      "",
    );
    const optionsB = await api("POST", "/signing-proof/options", { token: tokenB });
    const assertionB = nextB.sign(optionsB.body["challenge"] as Hex, validatorB, worldB.account);
    const doneB = await api("POST", "/signing-proof", {
      token: tokenB,
      body: { material: assertionB },
    });
    record(
      "B: the new PASSKEY signs a real WebAuthn assertion that the on-chain validator accepts",
      doneB.status === 200 && doneB.body["status"] === "COMPLETED",
      JSON.stringify(doneB.body),
    );
    const mirror = await repos.passkeys.listActiveForUser(worldB.userId);
    record(
      "B: the new passkey is the only active root passkey in the database",
      mirror.length === 1 && mirror[0]?.credentialId === nextB.ref,
      "",
    );
  }
  if (only.has("C")) {
    console.log("\n── C. recovery cancelled by the existing root ──");
    const rootC = newPasskey();
    const worldC = await createWorld(rootC, "c");
    created.push(worldC);
    const rootValidatorC = await currentRoot(worldC);
    const codeC = contracts.generateRecoveryCode();
    await armRecovery(worldC, codeC, worldC.setupToken, rootC, rootValidatorC);
    const tokenC = await startVerified(worldC);
    const { proof: proofC, signature: signatureC } = await proposeAndProve(
      worldC,
      tokenC,
      codeC,
      newDeviceKey(),
    );
    record("C: a recovery is pending on chain", proofC.body["status"] === "PENDING", "");
    const cancelToken = reportToken(worldC.email);
    const prepC = await api("POST", "/cancel/prepare", { token: cancelToken });
    const wrongCancel = await api("POST", "/cancel", {
      token: cancelToken,
      body: {
        material: newPasskey().sign(prepC.body["challenge"] as Hex, rootValidatorC, worldC.account),
      },
    });
    record(
      "C: a cancel signed by a passkey that is NOT the root is refused",
      wrongCancel.status === 400,
      String(wrongCancel.status),
    );
    const cancelC = await api("POST", "/cancel", {
      token: cancelToken,
      body: {
        material: rootC.sign(prepC.body["challenge"] as Hex, rootValidatorC, worldC.account),
      },
    });
    record(
      "C: the existing root cancels through a normal root-signed UserOperation; the attempt is CANCELLED",
      cancelC.status === 200 && cancelC.body["status"] === "CANCELLED",
      JSON.stringify(cancelC.body),
    );
    record(
      "C: the chain shows no pending recovery and a bumped recovery nonce",
      (await chain.validatorState(worldC.account)).pending === undefined &&
        (await chain.validatorState(worldC.account)).recoveryNonce === "1",
      "",
    );
    await sleep(30_000); // the 25 s test delay has now passed: the cancelled recovery would be mature
    const finalizeC = await api("POST", "/finalize", { token: tokenC });
    record(
      "C: a matured-but-cancelled attempt cannot finalize",
      finalizeC.status !== 200 || finalizeC.body["outcome"] === "NOT_ELIGIBLE",
      JSON.stringify(finalizeC.body),
    );
    const replayC = await api("POST", "/proof", { token: tokenC, body: { signature: signatureC } });
    record(
      "C: the old Recovery Code signature cannot be replayed",
      replayC.status !== 200 || replayC.body["status"] === "CANCELLED",
      JSON.stringify(replayC.body),
    );
    record(
      "C: no recovery is pending on chain after the replay attempt and the root is unchanged",
      (await chain.validatorState(worldC.account)).pending === undefined &&
        (await currentRoot(worldC)).toLowerCase() === rootValidatorC.toLowerCase(),
      "",
    );
    const { RecoverySweeper } = await import("../../src/recovery/recovery-sweeper.js");
    await app.get(RecoverySweeper).sweepNow(); // what a restarted process does first
    const rowC = await db.client.recoveryAttempt.findFirst({
      where: { walletId: worldC.walletId },
      orderBy: { createdAt: "desc" },
    });
    record(
      "C: a sweep (restart reconciliation) leaves the attempt CANCELLED and the root unchanged",
      rowC?.status === "CANCELLED" &&
        (await currentRoot(worldC)).toLowerCase() === rootValidatorC.toLowerCase(),
      String(rowC?.status),
    );
  }
  if (only.has("D")) {
    console.log("\n── D. recovery vetoed by the attestor ──");
    const rootD = newDeviceKey();
    const worldD = await createWorld(rootD, "d");
    created.push(worldD);
    const rootValidatorD = await currentRoot(worldD);
    const codeD = contracts.generateRecoveryCode();
    await armRecovery(worldD, codeD, worldD.setupToken, rootD, rootValidatorD);
    const tokenD = await startVerified(worldD);
    const { proof: proofD } = await proposeAndProve(worldD, tokenD, codeD, newPasskey());
    record("D: a recovery is pending on chain", proofD.body["status"] === "PENDING", "");
    const vetoD = await api("POST", "/report", { token: reportToken(worldD.email) });
    record(
      "D: 'this was not me' makes the attestor veto on chain; the attempt is VETOED",
      vetoD.status === 200 && vetoD.body["status"] === "VETOED",
      JSON.stringify(vetoD.body),
    );
    const storedD = await repos.recoveryAttempts.findById(
      (
        await db.client.recoveryAttempt.findFirst({
          where: { walletId: worldD.walletId },
          orderBy: { createdAt: "desc" },
        })
      )?.id ?? "",
    );
    record(
      "D: the veto transaction hash is recorded and the chain shows nothing pending",
      /^0x[0-9a-f]{64}$/.test(storedD?.terminationTxHash ?? "") &&
        (await chain.validatorState(worldD.account)).pending === undefined,
      "",
    );
    const strangerD = privateKeyToAccount(generatePrivateKey());
    let strangerRefused = false;
    try {
      await pub.simulateContract({
        address: state.recoveryProbe.validator as Hex,
        abi: viem.parseAbi(["function attestorCancel(address account)"]),
        functionName: "attestorCancel",
        args: [worldD.account],
        account: strangerD,
      });
    } catch {
      strangerRefused = true;
    }
    record("D: a stranger cannot veto (the contract refuses attestorCancel)", strangerRefused, "");
    await sleep(30_000); // past the test delay: the vetoed recovery would be mature
    const finalizeD = await api("POST", "/finalize", { token: tokenD });
    record(
      "D: a matured-but-vetoed attempt cannot finalize",
      finalizeD.status !== 200 || finalizeD.body["outcome"] === "NOT_ELIGIBLE",
      JSON.stringify(finalizeD.body),
    );
    const { RecoverySweeper: SweeperD } = await import("../../src/recovery/recovery-sweeper.js");
    await app.get(SweeperD).sweepNow();
    const rowD = await db.client.recoveryAttempt.findFirst({
      where: { walletId: worldD.walletId },
      orderBy: { createdAt: "desc" },
    });
    record(
      "D: after a sweep (restart reconciliation) the attempt is still VETOED, never stranded PENDING",
      rowD?.status === "VETOED",
      String(rowD?.status),
    );
    record(
      "D: the attestor alone cannot start or finish a recovery (its veto moved no root)",
      (await currentRoot(worldD)).toLowerCase() === rootValidatorD.toLowerCase(),
      "",
    );
  }
} catch (error) {
  record(
    "run completed without an unexpected error",
    false,
    String((error as Error).stack ?? error).slice(0, 600),
  );
} finally {
  const client = db.client;
  const userIds = created.map((w) => w.userId);
  const where = { userId: { in: userIds } };
  try {
    const permissions = await client.delegatedPermission.findMany({
      where,
      select: { sessionKeySecretId: true, approvalSecretId: true },
    });
    await client.auditEvent.deleteMany({ where });
    await client.recoveryAttempt.deleteMany({ where });
    await client.recoveryConfiguration.deleteMany({ where });
    await client.walletCredential.deleteMany({ where });
    await client.delegatedPermission.deleteMany({ where });
    await client.executionSecret.deleteMany({
      where: {
        id: {
          in: permissions
            .flatMap((p) => [p.sessionKeySecretId, p.approvalSecretId])
            .filter((id): id is string => id !== null),
        },
      },
    });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
  } catch (error) {
    console.log("cleanup warning:", (error as Error).message);
  }
  for (const cleanup of cleanups) await cleanup();
  await app.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  for (const f of failed) console.log("FAILED:", f.name, f.detail);
  process.exitCode = 1;
}
