import { validatePaymentRoute } from "@kaada/domain";
import type { ExecutionRepository, QuoteRepository, RouteRepository } from "@kaada/domain";

import {
  DataIntegrityError,
  executionCreateData,
  executionUpdateData,
  quoteCreateData,
  routeCreateData,
  toExecution,
  toQuote,
  toRoute,
} from "../mappers/index.js";
import type { Db } from "./db.js";

export function createQuoteRepository(db: Db): QuoteRepository {
  return {
    async create(quote) {
      return toQuote(await db.quote.create({ data: quoteCreateData(quote) }));
    },

    async findById(id) {
      const row = await db.quote.findUnique({ where: { id } });
      return row ? toQuote(row) : null;
    },

    async listByIntent(intentId) {
      const rows = await db.quote.findMany({
        where: { intentId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return rows.map(toQuote);
    },
  };
}

export function createRouteRepository(db: Db): RouteRepository {
  return {
    /** Route and steps are one nested write, so they are stored together or not at all. */
    async createWithSteps(route) {
      validatePaymentRoute(route);
      if (route.steps.some((step) => step.routeId !== route.id)) {
        throw new Error("every step.routeId must equal route.id");
      }
      const row = await db.route.create({ data: routeCreateData(route), include: { steps: true } });
      return toRoute(row);
    },

    async findById(id) {
      const row = await db.route.findUnique({
        where: { id },
        include: { steps: { orderBy: { position: "asc" } } },
      });
      return row ? toRoute(row) : null;
    },

    async updateStatus(id, status) {
      const row = await db.route.update({
        where: { id },
        data: { status },
        include: { steps: { orderBy: { position: "asc" } } },
      });
      return toRoute(row);
    },
  };
}

export function createExecutionRepository(db: Db): ExecutionRepository {
  return {
    /**
     * Idempotent on idempotencyKey via ON CONFLICT DO NOTHING: a replay returns the original row
     * unchanged (callers should compare it if the payload could differ).
     */
    async create(execution) {
      const { count } = await db.execution.createMany({
        data: [executionCreateData(execution)],
        skipDuplicates: true,
      });
      const row = await db.execution.findUnique({
        where: { idempotencyKey: execution.idempotencyKey },
      });
      if (!row)
        throw new DataIntegrityError("execution conflicted on id but not on idempotency key");
      return { execution: toExecution(row), created: count === 1 };
    },

    async findById(id) {
      const row = await db.execution.findUnique({ where: { id } });
      return row ? toExecution(row) : null;
    },

    async findByIdempotencyKey(idempotencyKey) {
      const row = await db.execution.findUnique({ where: { idempotencyKey } });
      return row ? toExecution(row) : null;
    },

    async update(id, update) {
      return toExecution(
        await db.execution.update({ where: { id }, data: executionUpdateData(update) }),
      );
    },
  };
}
