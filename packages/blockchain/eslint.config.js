import base from "@kaada/eslint-config/base";

// canary-mainnet.ts, deploy-recovery-contracts.ts, verify-attribution.ts, send-tagged-self.ts and register-agent-identity.ts are operational scripts (run with tsx, outside the build): they are not part of
// the library's tsconfig, so the type-aware linter cannot parse them. src/ is linted as usual.
const config = [
  ...base,
  {
    ignores: [
      "canary-mainnet.ts",
      "deploy-recovery-contracts.ts",
      "verify-attribution.ts",
      "send-tagged-self.ts",
      "register-agent-identity.ts",
    ],
  },
];

export default config;
