import type { Prisma } from "../generated/prisma/client.js";

/**
 * What repositories run queries on. A PrismaClient satisfies it, and so does the client Prisma hands
 * to an interactive transaction, so the same repositories work inside or outside one.
 */
export type Db = Prisma.TransactionClient;
