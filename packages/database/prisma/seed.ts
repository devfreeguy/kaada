import { createDatabase } from "../src/client/index.js";
import { seedFoundation } from "../src/seed/foundation.js";

// Run through `prisma db seed` (pnpm db:seed) so prisma.config.ts loads the repo-root .env first.
const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is required to seed the database");

const database = createDatabase({ url, poolMax: 2, poolTimeoutMs: 10_000 });
try {
  await seedFoundation(database.client);
  console.log("Seeded foundation records.");
} finally {
  await database.close();
}
