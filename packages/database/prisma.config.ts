import { defineConfig } from "prisma/config";

// Prisma 7 no longer reads .env on its own. The repo-root .env is optional.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

// Migrations need a direct (non-pooled) Neon connection; fall back to DATABASE_URL otherwise.
// With neither set, `generate` and `validate` still work.
const url = process.env["DATABASE_DIRECT_URL"] || process.env["DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  ...(url ? { datasource: { url } } : {}),
});
