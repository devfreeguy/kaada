import tseslint from "typescript-eslint";

import base from "./base.js";

// Nest relies on decorator metadata, so injected classes must stay value imports:
// no consistent-type-imports rule is enabled here.
export default tseslint.config(...base, {
  files: ["**/*.ts"],
  rules: {
    "@typescript-eslint/no-extraneous-class": "off",
  },
});
