# Wallet architecture (Build 10)

Decision document. **Selected: ZeroDev Kernel v3.3 smart account (ERC-4337, EntryPoint v0.7) with a passkey
(WebAuthn) root validator and on-chain permission policies for delegated session keys, behind Kaada-owned interfaces.**
Nothing in this build signs, executes or moves funds, and no unrestricted key exists anywhere.

## Why not a normal custodial wallet

Forbidden and not built: Kaada generates an EOA key, encrypts it with a PIN, stores it in Postgres. The PIN is never a
wallet encryption key. No custom MPC, threshold crypto or Shamir. The NestJS app exposes no signing primitive.

## Evidence gathered (2026-10-10)

Celo facts were checked **on chain** against Celo's public RPC (`https://forno.celo.org`, chain id 42220) with
`eth_getCode`, and compared with Base mainnet as a control where the bytecode size is identical:

| Component (address)                                                              | On Celo 42220                                                  |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| ERC-4337 EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`            | deployed (16035 bytes)                                         |
| ERC-4337 EntryPoint v0.6 `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`            | deployed (23689 bytes)                                         |
| Kernel v3.3 implementation `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28`          | deployed (24469, same as Base)                                 |
| Kernel v3.3 KernelFactory `0x2577507b78c2008Ff367261CB6285d44ba5eF2E9`           | deployed (950, same as Base)                                   |
| Kernel v3.3 MetaFactory `0xd703aaE79538628d27099B8c4f621bE4CCd142d5`             | deployed (1871, same as Base)                                  |
| ECDSA validator `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57`                     | deployed (1819)                                                |
| WebAuthn (passkey) validator v0.0.3 `0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69` | deployed (4739)                                                |
| Permissions: WebAuthn signer v0.0.4 `0x65DEeC8fEe717dc044D0CFD63cCf55F02cCaC2b3` | deployed                                                       |
| Permissions: Call policy v0.0.4 `0x9a52283276A0ec8740DF50bF01B28A80D880eaf2`     | deployed                                                       |
| Permissions: Timestamp / Gas / Rate-limit / Signature / Sudo policies            | deployed                                                       |
| Call policy v0.0.5, WebAuthn signer v0.0.3, rate-limit-with-reset                | **not deployed**: do not use                                   |
| RIP-7212 P-256 precompile `0x...0100`                                            | **works**: a real P-256 signature returned `1`, a bad one `0x` |

Addresses come from the packages' own constants (`@zerodev/sdk` 5.5.10 `KernelVersionToAddressesMap[KERNEL_V3_3]`,
`@zerodev/permissions` 5.6.3, `@zerodev/passkey-validator` 5.6.0). Safe's official deployment lists
(`safe-global/safe-modules-deployments`) were read for the Safe candidate. The Celo documentation pages I could retrieve
do not describe account abstraction at all; Celo support therefore rests on the on-chain checks above, not on a Celo
statement.

## Candidates (3)

### 1. ZeroDev Kernel v3.3 (selected)

- **Celo**: all core contracts and every policy listed above are deployed on 42220 (on-chain check). ZeroDev's _hosted_
  bundler/paymaster published chain list does **not** include Celo; the SDK is bundler-agnostic, so a third-party bundler
  that supports Celo is needed (Alchemy and Infura/Pimlico documentation lists Celo mainnet among bundler networks;
  to be confirmed with an account when execution is built).
- **Account standard**: ERC-4337 v0.7 + ERC-7579 modular accounts.
- **Passkeys**: WebAuthn validator as the root (sudo) validator; verification uses the P-256 precompile, which is live on
  Celo, so signatures are cheap.
- **Session/delegation**: a "permission" = 1 signer + N policies + 1 action. Policy modules exported by the SDK:
  call (contracts, function selectors, per-argument conditions, value limit), timestamp (valid from/until), gas, rate
  limit (count per interval), signature (which messages), sudo. **Policies are on-chain contracts the account calls
  during validation**, so they are cryptographically enforced by the account, not by Kaada.
- **Not available on-chain**: a cumulative token-spend limit. The call policy can bound a single call's argument
  (for example an `approve` amount) but nothing sums spend over time. There is no on-chain revocation by the session
  signer; only the root authority can uninstall a permission.
- **Bundler/paymaster**: bundler required to submit user operations; paymaster optional (Celo gas can be paid by the account
  in CELO or fee-abstraction tokens; a paymaster is not needed for Build 10).
- **SDK maturity**: widely used; `@zerodev/sdk`, `@zerodev/permissions`, `@zerodev/passkey-validator`, `viem`.
- **Cost/dependency**: no required ZeroDev hosted service when using our own WebAuthn registration and a third-party
  bundler. (ZeroDev's `toWebAuthnKey` register/login helpers call ZeroDev's _hosted passkey server_; we do not use them.)
- **Recovery**: not provided out of the box. Replacing a lost root passkey needs a recovery validator installed in advance
  (ERC-7579 module) or a second root credential; neither is built here (see Recovery).
- **Limitations**: cumulative limits are not on-chain; Celo is not on ZeroDev's hosted infra list; policy contract
  versions differ in what is deployed on Celo (pin them).

### 2. Safe (1.4.1) + Safe4337Module v0.3.0 (+ passkey module, allowance module)

- **Celo**: Safe v1.4.1 singleton and proxy factory, Safe4337Module v0.3.0 (`0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226`,
  verified on chain, 8373 bytes), SafeModuleSetup, and the Allowance module v0.1.0 (`0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134`)
  are all listed for 42220.
- **Passkeys**: Safe's passkey module (WebAuthn signer factory, shared signer, P-256 verifier) is **not listed for Celo** in
  the official deployments; Kaada would have to deploy and maintain it itself.
- **Delegation**: the Allowance module gives on-chain per-token allowances with reset periods, but it only authorises
  **transfers**; it cannot authorise `approve` plus a Textile swap call, which is what payments need. A general session-key
  system for Safe would be Rhinestone Smart Sessions through the 7579 adapter: Celo is claimed only by a partner directory
  and was not verified.
- **Verdict**: strong account, but the two features Kaada needs (passkeys and arbitrary-call delegation) are not both
  verified on Celo.

### 3. TEE/MPC embedded-wallet services (class: Privy, Turnkey and similar)

Not researched beyond the architecture class, and rejected on the stated requirements, not on product detail: the provider
holds or can use the key material (requirement 8), and spend restrictions are enforced by the provider's policy engine
(an off-chain check), not by the account. Recovery and cost depend on the vendor. Not selected.

## Selected architecture

```
User
 ├── Root authority: passkey (WebAuthn P-256). Kaada stores only the PUBLIC key.
 └── Celo Kernel v3.3 smart account (counterfactual address; deployed lazily)
       └── restricted Kaada delegated permission (later): session signer + on-chain policies
             └── used only by an isolated signer (future), never by AgentService
```

- **Root authority** is the user's passkey; its private key never leaves the user's authenticator. Kaada never holds a root
  secret, a mnemonic or an unrestricted key.
- **Address**: Kernel derives the account address from the validator configuration (the passkey public key). It is
  **counterfactual**: computable and stable before deployment. `deploymentStatus` is stored separately
  (`COUNTERFACTUAL` -> `DEPLOYED`); an undeployed account is never reported as deployed, and tokens sent to the address
  before deployment are safe at that address.
- **The address needs the passkey public key**, so the first real wallet is provisioned when the user registers a passkey in
  the browser. That UI is Build 10.1; Build 10 builds the server contracts (challenge, registration verification,
  public-key storage, authentication verification) and the provisioning orchestration, and tests them offline.

### Delegated permissions: cryptographic vs Kaada policy

| Control                                                                                   | Enforced by                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| chain, account                                                                            | the account (a permission lives in one account on one chain)        |
| allowed contracts and function selectors                                                  | **on-chain** call policy                                            |
| a per-call argument limit (e.g. `approve` amount, recipient/spender equality)             | **on-chain** call policy (parameter conditions)                     |
| validity window (from / until)                                                            | **on-chain** timestamp policy                                       |
| gas ceiling, request rate                                                                 | **on-chain** gas / rate-limit policy                                |
| cumulative spend over time                                                                | **Kaada policy only** (no on-chain policy)                          |
| per-intent limits, PaymentAuthorization, replay protection, "this execution was approved" | **Kaada policy only** (future build)                                |
| revocation                                                                                | root authority on-chain; Kaada can also stop using the key (policy) |

`DelegatedPermission` stores both sides separately (`onchainPolicy` and `kaadaPolicy`) so an application-side check is never
labelled cryptographic. **No unlimited session key is issued**: a permission requires at least a contract allow-list, an
expiry and a per-call limit, and the model cannot represent a sudo permission.

## Signer boundary

No `sign(bytes)` or `signTransaction(tx)` exists. The only signing contract is
`ExecutionSigner.signValidatedExecution(executionId)`. A future implementation loads the stored execution itself and must
check: wallet, chain, active permission, valid PaymentAuthorization, allowed contract and asset, permitted spend, expiry and
replay protection. Build 10 ships only a `DisabledExecutionSigner` that rejects with `EXECUTION_NOT_ENABLED`.
`AgentService` can read a wallet (`WalletService.getWallet`); it has no access to any signer, key or provider.

## Recovery (design only; nothing sent, nothing built)

lost device or passkey -> verify the registered email -> short-lived recovery process -> strong verification and a cooldown
-> register a replacement root credential -> revoke the old credential and every delegated permission -> audit. **Email
possession alone never authorises spending**: it can only open a recovery process. Changing the root authority of a Kernel
account is itself an on-chain action authorised by the existing root or by a recovery validator installed beforehand, so
real recovery needs that module (to be selected and audited, Build 10.x) or a second enrolled passkey. Until then a lost
passkey leaves the wallet in `RECOVERY_REQUIRED`; Kaada cannot move the funds, by design.

## Provisioning and idempotency

`WalletService.ensureEmbeddedWallet(userId)`: one `EMBEDDED` wallet per user and chain, enforced by a partial unique index
and a conversation-style row lock on the user. A concurrent second call waits and returns the same wallet; a provider failure
leaves the row `PROVISIONING` with a recorded failure so a retry resumes it (the provider address derivation is
deterministic, so retries cannot create a second account). Statuses: `PROVISIONING`, `ACTIVE`, `SUSPENDED`, `REVOKED`,
`RECOVERY_REQUIRED`. Every transition is written to the append-only audit table without secrets.

## External services still required

A Celo RPC URL (the public `forno.celo.org` works for reads; a keyed provider is better for production), and, for
execution builds, a bundler that supports Celo (and optionally a paymaster). Nothing else; no Kaada-held signing secret.

## What Build 10 implemented

- **Kaada-owned contracts** (`packages/domain/src/wallets`): `WalletProvisioningAdapter`, `WalletPolicyAdapter`,
  `ExecutionSigner` (only `signValidatedExecution(executionId)`), `WalletBalanceReader`, `PasskeyVerifier`,
  `FirmQuoteContext`, plus the `Wallet`, `PasskeyCredential`, `PasskeyChallenge` and `DelegatedPermission` models.
  Domain and application code import no wallet SDK type.
- **Stack behind the contracts** (`packages/blockchain`): `KernelProvisioningAdapter` (derives the counterfactual
  Kernel v3.3 address from the passkey's public coordinates; asks the chain whether it is deployed),
  `KernelPolicyAdapter` (the cryptographic-vs-Kaada-policy table above), `ChainBalanceReader` (read-only ERC-20
  balances through Multicall3, canonical `Money`, optional on-chain `decimals()` verification) and
  `DisabledExecutionSigner` (refuses everything with `EXECUTION_NOT_ENABLED`). `kernel-deriver.ts` is the only file
  that touches the wallet SDK.
- **Application** (`apps/api/src/core/wallets`): `WalletService` (`ensureEmbeddedWallet`, status transitions,
  bounded delegated permissions, `firmQuoteContext`) and `PasskeyService` (one-time challenges, WebAuthn
  verification through `@simplewebauthn/server`, public-key storage, counter enforcement, revocation that moves the
  wallet to `RECOVERY_REQUIRED` when the last passkey goes). Every transition is written to the append-only audit
  table without secrets. There is no HTTP controller yet.
- **Provisioning concurrency**: a per-user row lock serialises the decision, a partial unique index allows one
  non-revoked EMBEDDED wallet per user and chain, and the provider call runs outside any transaction. Two callers
  both derive (the address is a pure function of the passkey) and one `activate` wins.
- **Configuration**: `WALLET_PROVIDER=none|kernel`, `CELO_RPC_URL`, `PASSKEY_RP_ID`, `PASSKEY_ORIGIN`, `PASSKEY_RP_NAME`. Kernel needs a
  relying party and an origin on that domain; production needs https for both the origin and the RPC.

## Verified live (read-only, `pnpm --filter @kaada/api smoke:wallet`)

A throwaway P-256 public key produced a real Kernel v3.3 address on Celo (`COUNTERFACTUAL`, stable across calls, no
code at the address). Reading the six seeded tokens at that address through Multicall3 returned zero balances, and every
token's on-chain `decimals()` matched the registry (USDT 6, USDC 6, wBRL 18, wARS 18, cNGN 6, IDRX 2).

## Not built here (and why)

- **The browser half of passkey registration** (`navigator.credentials`) and a controller: Build 10.1. The address
  needs the user's passkey public key, so no real user wallet exists until then.
- **Deploying the account, installing a permission, creating a session key, signing**: need the root passkey's
  signature and a bundler that supports Celo. A `PENDING` permission is only a validated record.
- **Cumulative spend limits on chain**: no such policy exists in the SDK; they stay Kaada policy.
- **Recovery**: needs a recovery validator installed in advance (or a second enrolled passkey); to be selected and
  audited. Until then a lost last passkey means `RECOVERY_REQUIRED`.
- **Affordability filtering in routing**: the balance reader exists but is not wired into candidates.

## Out of scope for Build 10

PIN, PaymentAuthorization, authorization sessions, email sending, deploying the account, creating a session key, signing,
Textile firm quotes, routing affordability filtering.

# Build 10.1: passkey onboarding, wallet API, balance-aware routing

## Setup sessions

WebAuthn needs a secure browser origin, and Telegram/WhatsApp cannot run it. A channel that has authenticated a user
calls `WalletSetupService.createSession(userId)` and hands over `PASSKEY_ORIGIN/setup/<token>`.

- The token is 32 random bytes (base64url). Only its SHA-256 is stored (`WalletSetupSession.tokenHash`, CHECKed to be a
  hex digest). The server looks a token up by hash and reads the user from the row; **no request ever names a user**.
- Valid for 15 minutes, one live link per user (a new link revokes older ones, serialised by the per-user lock).
- States: `PENDING` -> `COMPLETED` (registration finished, consumed by one conditional UPDATE) or `REVOKED`. A completed
  link allows read-only views (wallet, balances) until it expires; it never registers a second passkey.
- Unknown, malformed, expired, used or replaced tokens all give the same 401.
- The link is a bearer secret, so it is never put in an agent response or conversation history. The channel creates a
  link when it renders its "Set up wallet" button. Until Telegram/WhatsApp exist, `POST /api/v1/wallet/dev/setup-sessions`
  (404 in production) stands in for that channel.

## Endpoints (token sent as `Authorization: Bearer <token>`, never in a body or query)

| Endpoint                                            | Purpose                                                       |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `POST /api/v1/wallet/passkeys/registration/options` | WebAuthn creation options (ES256 only, UV required)           |
| `POST /api/v1/wallet/passkeys/registration/verify`  | verify, store public key, activate wallet, consume link       |
| `POST /api/v1/wallet/setup/finalize`                | finish after a provisioning failure (no second passkey)       |
| `GET /api/v1/wallet`                                | setup state, passkey registered?, wallet view                 |
| `GET /api/v1/wallet/balances`                       | fresh Celo balances of the supported tokens (canonical Money) |

Responses never contain provider ids, public keys, challenges or tokens. Registration is verified server-side by
`@simplewebauthn/server`: single-use challenge (5 min), origin, RP id, user verification, ES256 only.

## Wallet activation

A verified registration stores the **public** credential, then `ensureEmbeddedWallet` derives the counterfactual Kernel
address from it and activates the wallet (`ACTIVE` + `COUNTERFACTUAL`). No chain write happens; the address can receive
supported Celo ERC-20s before the account is deployed. A user with an active wallet or an existing passkey cannot register
another one here (adding passkeys is a recovery-build feature).

## Balance-aware routing

`RoutingRequest -> candidate resolver -> WalletFundingResolver -> RoutePlanner`. The planner never sees a wallet.

- Only a PAYMENT needs a wallet (`WALLET_SETUP_REQUIRED` if none); a QUOTE never touches one.
- Funding status per candidate: `NO_BALANCE`, `POTENTIALLY_FUNDED` (exact output, amount unknown until priced), `FUNDED`
  (exact input covered), `INSUFFICIENT`, `INSUFFICIENT_AFTER_QUOTE`.
- EXACT_INPUT: the balance must cover the exact input before any price is requested.
- EXACT_OUTPUT: funded candidates are priced; the best-ranked route whose **maximum** spend (estimate plus slippage)
  fits the balance wins; an alternative funded source is used when the best one falls short.
- An explicit source is never swapped (`INSUFFICIENT_BALANCE`); with none, every funded candidate stays and **price, not
  balance size, chooses**. No funded asset at all is `WALLET_NEEDS_FUNDING`.
- `no_makers_online` stays a routing failure (`ROUTING_UNAVAILABLE`), not a balance failure. An unreadable chain is
  `ROUTING_UNAVAILABLE` too, never a balance verdict.
- A reused stored route is re-checked against a fresh balance. Balances are read fresh and never stored.
- No firm Textile quote is requested and nothing signs or executes.

## Not built here

PIN, PaymentAuthorization, firm RFQ, execution, token approvals, delegated signing, Telegram/WhatsApp buttons, email
recovery, general (non-setup-link) user authentication for the wallet API.
