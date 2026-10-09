import { createDatabase } from "./prisma.js";
import type { Database, DatabaseConfig } from "./prisma.js";

// Stored on globalThis so module reloads (dev servers, HMR) reuse one pool instead of leaking one
// per reload. The first call's config wins.
const globalStore = globalThis as typeof globalThis & { __kaadaDatabase?: Database };

/** Returns the process-wide database, creating it on first use. */
export function getSharedDatabase(config: DatabaseConfig): Database {
  if (!globalStore.__kaadaDatabase) {
    const database = createDatabase(config);
    globalStore.__kaadaDatabase = {
      ...database,
      async close() {
        delete globalStore.__kaadaDatabase;
        await database.close();
      },
    };
  }
  return globalStore.__kaadaDatabase;
}
