import base from "@kaada/eslint-config/base";

// canary-mainnet.ts is an operational script for the real-mainnet bundler canary (run with tsx, outside the build): it is not part of
// the library's tsconfig, so the type-aware linter cannot parse it. src/ is linted as usual.
const config = [...base, { ignores: ["canary-mainnet.ts"] }];

export default config;
