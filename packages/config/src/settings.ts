/*
 * Settings that are NOT environment variables.
 *
 * Environment variables are for two things only: secrets, and facts that differ per deployment (URLs, switches, key
 * locations). Everything below is neither: it is the same everywhere, it is not secret, and a typo in an environment must not
 * be able to change it. It lives in code, so a change is reviewed, tested and versioned like any other change.
 *
 * Several of these are SECURITY FLOORS (authorization lifetimes, the recovery delay, the attestation level). They are
 * deliberately not overridable from the environment: weakening one is a code change with a diff, not a deployment accident.
 */

export const SETTINGS = {
  /** Celo mainnet is the only chain Kaada settles on (Textile has no Celo testnet). */
  celo: { network: "mainnet", chainId: 42220 },

  database: {
    poolMax: 10,
    poolTimeoutMs: 10_000,
    /**
     * The services keep transactions short and never hold one across a chain, model or provider call. What they DO hold is a
     * run of small queries: a conversation lock, the intent, the recipient lookup, the asset lookups, the clarification
     * options, the stored reply. Against a managed Postgres several hundred milliseconds away that is twenty round trips, and
     * Prisma's 5 s default left no headroom: a turn would pass 5 s mid-write and the whole turn failed with "a query cannot
     * be executed on an expired transaction", losing a reply the person had already waited for. It is a ceiling for a stuck
     * transaction, not a target, and work that could really take this long (pricing, the model, the chain) is outside it.
     */
    transactionTimeoutMs: 20_000,
  },

  /** Rate limiting keys (Redis). Changing the prefix resets every limit. */
  redis: { keyPrefix: "kaada:rl:" },

  agent: {
    /** Must support strict structured output (json_schema). */
    groq: {
      model: "openai/gpt-oss-20b",
      timeoutMs: 8_000,
      /** The conversation presenter (wording only; never decides anything). The person waits for it, so it is bounded tighter. */
      presentation: { timeoutMs: 5_000, temperature: 0.7 },
    },

    /**
     * The interpreter providers, in the order AGENT_INTERPRETER_CHAIN may name them. Models and endpoints only: every
     * key comes from the environment, so nothing secret is ever committed here.
     *
     * Each is tried in turn when the one before it cannot answer (see FallbackIntentInterpreter). The order is a
     * deployment's choice, not a default, because it is a real trade: the first provider is the one whose reading of
     * people's messages the prompt has actually been drilled against, and any other is a model that may read the same
     * sentence differently.
     *
     * Cerebras and Google are reached through their OpenAI-compatible endpoints, so they share the Groq transport;
     * Claude speaks its own protocol and has its own.
     */
    providers: {
      anthropic: { protocol: "anthropic", model: "claude-haiku-5-5", timeoutMs: 8_000 },
      cerebras: {
        protocol: "openai",
        model: "gpt-oss-120b",
        baseUrl: "https://api.cerebras.ai/v1",
        timeoutMs: 8_000,
      },
      // No baseUrl: Groq is the transport's own default endpoint.
      groq: { protocol: "openai", model: "openai/gpt-oss-20b", timeoutMs: 8_000 },
      openrouter: {
        protocol: "openai",
        /**
         * The same model Groq serves and the prompt is drilled against, so a fallback here reads a message the way the
         * primary would — the one thing no other provider in this table can offer. Paid, but per-token rather than
         * per-day, which is the cap that actually stops work.
         *
         * Pin a model; never route to OpenRouter's automatic free-model selector. It chooses a different host per
         * request, several of which may train on what they are sent, and what is sent here is a person's payment
         * instruction with a real name and amount in it.
         */
        model: "openai/gpt-oss-20b",
        baseUrl: "https://openrouter.ai/api/v1",
        timeoutMs: 8_000,
      },
      gemini: {
        protocol: "openai",
        /**
         * The moving alias, not a pinned version. Google retires these from under you: `gemini-2.5-flash` answered
         * "no longer available to new users" with a 404 when this chain was first probed, and the list of Flash models
         * on one key ran from 2.5 to 3.8. For a provider that only answers when three others could not, surviving a
         * rename matters more than knowing exactly which weights replied. Override with GEMINI_MODEL to pin one.
         */
        model: "gemini-flash-latest",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
        timeoutMs: 8_000,
      },
    },
  },

  textile: {
    /** The documented API host; the /v2 paths are added by the client. */
    apiUrl: "https://api.textilecredit.com",
    timeoutMs: 8_000,
  },

  uniswap: {
    /** The Trading API root; the client adds /quote, /swap and /check_approval. */
    apiUrl: "https://trade-api.gateway.uniswap.org/v1",
    timeoutMs: 8_000,
    /**
     * Slippage bound written into the swap calldata, in percent (Uniswap's own unit).
     *
     * An AMM reserves nothing, so this — not a quote expiry — is what protects the person when the pool moves between
     * the price they saw and the block their swap lands in. 2.5% is Uniswap's own default for these pairs, observed on
     * a live quote; the local-currency pools on Celo are thin enough that a tighter bound reverts instead of filling,
     * and a reverted swap costs gas and delivers nothing.
     */
    slippagePercent: 2.5,
    /**
     * How long a Uniswap quote is honoured once made: 3 minutes. Long enough to read and confirm; short enough that
     * the pool price has not drifted far. After it, the person simply gets a fresh quote.
     */
    quoteLifetimeMs: 180_000,
  },

  routing: {
    /**
     * The smallest payment worth attempting, in US dollars.
     *
     * One number rather than nine, because the dollar is where the limit actually bites: every cross-currency route
     * passes through USDT, and it is that leg which refuses a figure too small to be worth quoting. One naira is
     * seven ten-thousandths of a dollar, and no provider will price it.
     *
     * Expressed to the person in THEIR currency, converted at the live rate, so it stays right as rates move instead
     * of becoming a stale table of per-currency floors. It is deliberately a round, slightly generous figure: a
     * refusal that names a workable amount is useful, and one that names a figure which then also fails is not.
     *
     * It governs SENDING only. A rate question never meets it: rates are read against the dollar, so nothing dust-sized
     * is ever quoted in the first place.
     *
     * Why there is still a floor at all, rather than none. The limit is not a policy choice, it is where the market
     * stops answering: one naira is about seven ten-thousandths of a dollar, and a probe of 1 cNGN came back
     * unquotable. A send below the floor is refused with the smallest amount that WOULD work, which is useful; a send
     * the provider then declines for its own reasons is not. Lowered from 1.00 so a 1,500 naira balance is two
     * testable payments rather than one.
     */
    minimumSendUsd: "0.50",
  },

  passkey: { rpName: "Kaada" },

  /** Both deliberately short: the time to open the link and enter the PIN (5 min), and how long an approved payment may run (10 min; a first-time wallet setup in a browser needs more than 3). */
  authorization: { sessionTtlSeconds: 300, paymentTtlSeconds: 600 },

  execution: {
    /** Receipt polling inside one run; the reconciler continues anything still pending afterwards. */
    pollIntervalMs: 2_000,
    pollMaxWaitMs: 45_000,
    reconcileIntervalSeconds: 30,
    /** The least time that must remain on a firm quote before it is treated as executable. */
    minFirmWindowSeconds: 12,
    /** Textile documents about 70 s for a firm request and recommends a 75 s client timeout. */
    firmTimeoutMs: 75_000,
    /**
     * The one-time Permit2 -> router grant a Uniswap swap needs: a size in WHOLE tokens and a lifetime.
     *
     * Generous, and safe because of where the binding limit sits. Permit2 moves tokens by calling
     * `transferFrom` on the token itself, so it can never move more than the ERC-20 allowance granted to
     * Permit2, and Kaada rebuilds THAT on every payment, bounded to exactly one swap's input. Verified on
     * Celo mainnet: with a 1,000 cNGN Permit2 allowance and a 10 cNGN ERC-20 one, a 100 cNGN swap reverts
     * with TRANSFER_FROM_FAILED, which is the ERC-20 layer refusing.
     *
     * So these figures decide only how often someone is asked for their root signature, never how much can
     * move. Thirty days rather than a year: the grant is only ever made to a router Kaada has pinned
     * (TRUSTED_PERMIT2_SPENDERS), and a shorter life keeps a standing allowance from outliving its usefulness.
     */
    permit2Grant: { wholeTokens: 1_000_000n, durationSeconds: 30n * 24n * 3600n },
    /**
     * The standing permission for converting between a person's OWN currencies, with no PIN and no passkey per conversion.
     *
     * A conversion pays its output back to the wallet it came from, so nothing can leave the wallet through it: the
     * on-chain payout is pinned to the wallet's own address. That is what allows one permission, installed once per
     * currency pair with the person's passkey, to serve every later conversion of that pair. Its ceilings are in WHOLE
     * tokens (the same unit for every token, whatever its precision) and it lasts 30 days.
     *
     * What the chain cannot pin is the receiver INSIDE the swap router's data. Kaada checks, when it builds the quote, that
     * the output goes to the wallet; the chain does not enforce it. That trade-off is deliberate and limited to
     * conversions: a SEND to another person keeps its exact, short-lived, recipient-pinned permission and its PIN or
     * passkey.
     */
    standingConversion: { wholeTokens: 1_000_000n, windowMs: 30 * 24 * 3600 * 1000 },
  },

  /**
   * What counts as "set up": a wallet, a PIN, and, once the wallet has received its first funds, recovery (a verified email, an
   * authenticator app and a Recovery Code). Kaada is non-custodial, so nobody can recover a lost device for a person who never set
   * this up; but until funds arrive nothing is at risk and the wallet may not exist on chain yet, so nobody is asked before then.
   * It only applies where this deployment has recovery enabled (see the onboarding state reader).
   */
  onboarding: { requireRecovery: true },

  /** Deposit detection. Polling, at the application level (one pass for every wallet, never one timer per chat). */
  funding: {
    /** How often supported balances are re-read. Each wallet is one batched call covering all of its tokens. */
    pollSeconds: 30,
    /** A deposit smaller than 1/100 of a token is recorded silently (dust never pings anyone). */
    dustDecimalsBelow: 2,
    /**
     * A payment left open this long ago is not brought back by a deposit: the person gets the plain funding message. The
     * payment records themselves are untouched.
     */
    resumeWindowMs: 60 * 60 * 1000,
    /** A wallet with no checkpoint yet counts as "just created" (a first deposit is news) only within this long of activation. */
    newWalletMs: 24 * 60 * 60 * 1000,
  },

  recovery: {
    sweepIntervalSeconds: 30,
  },

  attestation: {
    /** The weakest Android hardware level that counts as TRUSTED_DEVICE. A product decision, reviewed in code. */
    androidMinimumLevel: "TEE" as "TEE" | "STRONGBOX",
    challengeTtlSeconds: 300,
    /** Google's revoked-certificate list; unreachable and uncached means the evidence is refused. */
    revocationUrl: "https://android.googleapis.com/attestation/status",
    revocationCacheSeconds: 3_600,
  },
} as const;
