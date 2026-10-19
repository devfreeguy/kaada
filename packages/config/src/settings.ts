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
    /** The services keep transactions short and never hold one across a chain or provider call. */
    transactionTimeoutMs: 5_000,
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
  },

  textile: {
    /** The documented API host; the /v2 paths are added by the client. */
    apiUrl: "https://api.textilecredit.com",
    timeoutMs: 8_000,
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
    /** Textile allows 4 outstanding firm RFQs per key; Kaada counts its own to avoid avoidable 429s. */
    maxOutstandingRfqs: 4,
  },

  /**
   * What counts as "set up": a wallet, a PIN, and recovery (a verified email, an authenticator app and a Recovery Code). Kaada is
   * non-custodial, so nobody can recover a lost device for a person who never set this up: it is required before onboarding is
   * complete. It only applies where this deployment has recovery enabled (see the onboarding state reader).
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
