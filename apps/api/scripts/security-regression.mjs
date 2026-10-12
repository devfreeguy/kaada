// Runs the security regression suite listed in test/security/manifest.json (see that file for the areas it covers).
//   node scripts/security-regression.mjs [--integration]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../test/security/manifest.json", import.meta.url), "utf8"),
);
const files = new Set(
  Object.values(manifest.areas)
    .flat()
    .map((name) => `test/${name}`),
);
if (process.argv.includes("--integration"))
  for (const name of manifest.integration) files.add(`test/${name}`);

console.log(
  `security regression: ${String(files.size)} test files across ${String(Object.keys(manifest.areas).length)} areas`,
);
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  cwd: new URL("..", import.meta.url),
});
process.exit(result.status ?? 1);
