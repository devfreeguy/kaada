import type {
  PaymentAuthorization,
  ExecutionPlanRecord,
  ExecutionPlanRepository,
  ExecutionSecretRepository,
  FirmQuoteAttempt,
  FirmQuoteAttemptRepository,
} from "@kaada/domain";

/*
 * In-memory implementations of the firm-quote repository contracts for offline tests. Every method is
 * synchronous inside, so each conditional transition is atomic like the single SQL statement it stands
 * in for, and the "one live attempt per authorization and provider" rule is enforced like the index.
 */

export interface FirmStores {
  attempts: FirmQuoteAttempt[];
  secrets: { id: string; purpose: string; keyVersion: number; ciphertext: string }[];
  plans: ExecutionPlanRecord[];
  repositories: {
    firmQuoteAttempts: FirmQuoteAttemptRepository;
    executionSecrets: ExecutionSecretRepository;
    executionPlans: ExecutionPlanRepository;
  };
}

export function createFirmStores(payments: PaymentAuthorization[] = []): FirmStores {
  const attempts: FirmQuoteAttempt[] = [];
  const secrets: FirmStores["secrets"] = [];
  const plans: ExecutionPlanRecord[] = [];
  const copy = <T extends object>(value: T): T => ({ ...value });
  const isLive = (a: FirmQuoteAttempt) => a.status === "REQUESTING" || a.status === "QUOTED";

  const firmQuoteAttempts: FirmQuoteAttemptRepository = {
    claim: (input, now) => {
      const live = attempts.find(
        (a) =>
          a.paymentAuthorizationId === input.paymentAuthorizationId &&
          a.providerId === input.providerId &&
          isLive(a),
      );
      if (live) return Promise.resolve({ attempt: copy(live), claimed: false });
      if (attempts.some((a) => a.idempotencyKey === input.idempotencyKey)) {
        return Promise.reject(new Error("duplicate idempotency key"));
      }
      const attempt: FirmQuoteAttempt = {
        ...input,
        status: "REQUESTING",
        createdAt: now,
        updatedAt: now,
      };
      attempts.push(attempt);
      return Promise.resolve({ attempt: copy(attempt), claimed: true });
    },
    findById: (id) =>
      Promise.resolve(copy(attempts.find((a) => a.id === id) ?? ({} as never)) ?? null),
    listByAuthorization: (id) =>
      Promise.resolve(
        attempts
          .filter((a) => a.paymentAuthorizationId === id)
          .map(copy)
          .reverse(),
      ),
    recordQuoted: (id, fields, now) => {
      const a = attempts.find((x) => x.id === id);
      if (!a || a.status !== "REQUESTING") return Promise.resolve(null);
      Object.assign(a, {
        status: "QUOTED",
        updatedAt: now,
        providerQuoteId: fields.providerQuoteId,
        input: fields.input,
        output: fields.output,
        fee: fields.fee,
        reactor: fields.reactor,
        spender: fields.spender,
        expiresAt: fields.expiresAt,
        orderDeadline: fields.orderDeadline,
        latestOrderDeadline: fields.latestOrderDeadline,
        unsignedTransactions: fields.unsignedTransactions,
        claimSecretId: fields.claimSecretId,
      });
      return Promise.resolve(copy(a));
    },
    recordFailure: (id, status, code, now) => {
      const a = attempts.find((x) => x.id === id);
      if (!a || a.status !== "REQUESTING") return Promise.resolve(null);
      Object.assign(a, { status, failureCode: code, updatedAt: now });
      return Promise.resolve(copy(a));
    },
    markUnusable: (id, code, now) => {
      const a = attempts.find((x) => x.id === id);
      if (!a || a.status !== "QUOTED") return Promise.resolve(null);
      Object.assign(a, { status: "UNUSABLE", failureCode: code, updatedAt: now });
      return Promise.resolve(copy(a));
    },
    markExpired: (id, now) => {
      const a = attempts.find((x) => x.id === id);
      if (!a || a.status !== "QUOTED" || !a.expiresAt || a.expiresAt.getTime() > now.getTime()) {
        return Promise.resolve(null);
      }
      Object.assign(a, { status: "EXPIRED", updatedAt: now });
      return Promise.resolve(copy(a));
    },
    countHeldSlots: (providerId, now, holdMs) => {
      let held = 0;
      for (const a of attempts) {
        if (a.providerId !== providerId) continue;
        const until = (a.latestOrderDeadline ?? a.expiresAt)?.getTime();
        if (a.status === "REQUESTING") held += 1;
        else if (
          (a.status === "QUOTED" || a.status === "UNUSABLE") &&
          until &&
          until > now.getTime()
        ) {
          held += 1;
        } else if (a.status === "TIMED_OUT" && a.updatedAt.getTime() > now.getTime() - holdMs) {
          held += 1;
        }
      }
      return Promise.resolve(held);
    },
  };

  const executionSecrets: ExecutionSecretRepository = {
    put: ({ id, purpose, keyVersion, ciphertext }) => {
      secrets.push({ id, purpose, keyVersion, ciphertext });
      return Promise.resolve();
    },
    get: (id) => {
      const found = secrets.find((s) => s.id === id);
      return Promise.resolve(found && found.ciphertext ? (found as never) : null);
    },
    tombstone: (id) => {
      const found = secrets.find((s) => s.id === id);
      if (found) found.ciphertext = "";
      return Promise.resolve();
    },
  };

  const executionPlans: ExecutionPlanRepository = {
    begin: (record) => {
      const existing = plans.find(
        (p) => p.paymentAuthorizationId === record.paymentAuthorizationId,
      );
      if (existing) return Promise.resolve({ record: copy(existing), created: false });
      const created: ExecutionPlanRecord = {
        ...record,
        status: "PREPARING",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      plans.push(created);
      return Promise.resolve({ record: copy(created), created: true });
    },
    findByAuthorization: (id) => {
      const found = plans.find((p) => p.paymentAuthorizationId === id);
      return Promise.resolve(found ? copy(found) : null);
    },
    findById: (id) => {
      const found = plans.find((p) => p.id === id);
      return Promise.resolve(found ? copy(found) : null);
    },
    transition: (id, from, to, fields = {}) => {
      const p = plans.find((x) => x.id === id);
      if (!p || !from.includes(p.status)) return Promise.resolve(null);
      p.status = to;
      p.updatedAt = new Date();
      const { userActionKind, plan, ...rest } = fields;
      Object.assign(p, rest);
      if (userActionKind === null) delete p.userActionKind;
      else if (userActionKind !== undefined) p.userActionKind = userActionKind;
      if (plan) p.plan = plan;
      return Promise.resolve(copy(p));
    },
    acquire: (id, now) => {
      // One synchronous block: lock-check, consume and move, like the row lock + transaction.
      const p = plans.find((x) => x.id === id);
      if (!p || p.status !== "READY") return Promise.resolve({ status: "NOT_READY" as const });
      const auth = payments.find((a) => a.id === p.paymentAuthorizationId);
      if (!auth || auth.status !== "ACTIVE" || auth.expiresAt.getTime() <= now.getTime()) {
        return Promise.resolve({ status: "AUTHORIZATION_UNAVAILABLE" as const });
      }
      auth.status = "CONSUMED";
      auth.consumedAt = now;
      p.status = "SIGNING";
      p.authorizationConsumedAt = now;
      p.providerSubmitState = "PENDING";
      p.updatedAt = now;
      return Promise.resolve({ status: "ACQUIRED" as const, record: copy(p) });
    },
    listByStatus: (statuses, limit) =>
      Promise.resolve(
        plans
          .filter((p) => statuses.includes(p.status))
          .slice(0, limit)
          .map(copy),
      ),
    update: (id, update) => {
      const p = plans.find((x) => x.id === id);
      if (!p) return Promise.reject(new Error("no such plan record"));
      Object.assign(p, update, { updatedAt: new Date() });
      return Promise.resolve(copy(p));
    },
  };

  return {
    attempts,
    secrets,
    plans,
    repositories: { firmQuoteAttempts, executionSecrets, executionPlans },
  };
}
