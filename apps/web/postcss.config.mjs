import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const config = {
  // Keep native plugin resolution in Node, outside Turbopack's module identifiers.
  plugins: { [require.resolve(/* turbopackIgnore: true */ "@tailwindcss/postcss")]: {} },
};

export default config;
