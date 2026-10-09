import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client.js";

export interface DatabaseConfig {
  /** Pooled runtime connection string (Neon: the "-pooler" host). */
  url: string;
  poolMax: number;
  poolTimeoutMs: number;
  /** Called for errors on idle pooled connections, e.g. Neon closing them. */
  onError?: (error: Error) => void;
}

export interface Database {
  /**
   * The Prisma client. Internal to @kaada/database: repository implementations use it, application
   * code depends on repositories instead.
   */
  readonly client: PrismaClient;
  /** Rejects if the database cannot be reached. */
  ping(): Promise<void>;
  /** Closes the connection pool. Safe to call more than once. */
  close(): Promise<void>;
}

/** Creates an independent client and pool. Prefer this in tests and workers. */
export function createDatabase(config: DatabaseConfig): Database {
  const adapter = new PrismaPg(
    {
      connectionString: config.url,
      max: config.poolMax,
      connectionTimeoutMillis: config.poolTimeoutMs,
    },
    config.onError && { onPoolError: config.onError, onConnectionError: config.onError },
  );
  const client = new PrismaClient({ adapter });

  return {
    client,
    async ping() {
      await client.$queryRaw`SELECT 1`;
    },
    close: () => client.$disconnect(),
  };
}
