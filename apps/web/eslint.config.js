import next from "@kaada/eslint-config/next";

// The vendored QR encoder is third-party code kept byte-for-byte (see app/lib/vendor/README.md): not linted.
const config = [...next, { ignores: ["app/lib/vendor/**"] }];

export default config;
