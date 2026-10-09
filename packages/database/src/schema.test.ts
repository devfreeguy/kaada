import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const schema = read("../prisma/schema.prisma");
const constraints = read(
  "../prisma/migrations/20261009000001_money_and_asset_constraints/migration.sql",
);

interface Field {
  name: string;
  type: string;
  optional: boolean;
  attributes: string;
}

function blocks(kind: "model" | "enum"): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const match of schema.matchAll(
    new RegExp(`^${kind} (\\w+) \\{\\n([\\s\\S]*?)\\n\\}`, "gm"),
  )) {
    const lines = (match[2] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"));
    result.set(match[1] ?? "", lines);
  }
  return result;
}

const models = new Map<string, Field[]>();
for (const [name, lines] of blocks("model")) {
  models.set(
    name,
    lines.map((line) => {
      const [fieldName = "", rawType = "", ...rest] = line.split(/\s+/);
      return {
        name: fieldName,
        type: rawType.replace(/[?[\]]/g, ""),
        optional: rawType.endsWith("?"),
        attributes: rest.join(" "),
      };
    }),
  );
}
const enums = blocks("enum");

const modelNames = [
  "User",
  "Identity",
  "Session",
  "Wallet",
  "Asset",
  "Conversation",
  "Message",
  "Intent",
  "Recipient",
  "Provider",
  "ProviderCapability",
  "Quote",
  "Route",
  "RouteStep",
  "Execution",
  "Transaction",
  "RampSession",
  "AuditEvent",
  "ClarificationOption",
];

const enumValues: Record<string, string[]> = {
  IdentityType: ["TELEGRAM", "WHATSAPP", "PHONE", "EMAIL", "DISCORD", "X"],
  ChannelType: ["TELEGRAM", "WHATSAPP", "WEB", "DISCORD", "X"],
  ConversationStatus: ["ACTIVE", "COMPLETED", "ARCHIVED"],
  MessageRole: ["USER", "ASSISTANT", "SYSTEM", "TOOL"],
  IntentType: ["SEND", "CONVERT", "QUOTE", "BALANCE", "TRANSACTION_STATUS", "HELP", "UNKNOWN"],
  IntentStatus: [
    "DRAFT",
    "AWAITING_DETAILS",
    "RESOLVED",
    "QUOTING",
    "AWAITING_CONFIRMATION",
    "EXECUTING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "EXPIRED",
  ],
  AmountMode: ["EXACT_INPUT", "EXACT_OUTPUT"],
  RecipientType: [
    "KAADA_USER",
    "USERNAME",
    "TELEGRAM_USER",
    "PHONE_NUMBER",
    "WALLET_ADDRESS",
    "SAVED_BENEFICIARY",
    "EXTERNAL_PAYMENT_ADDRESS",
  ],
  AssetKind: ["FIAT", "USD_STABLECOIN", "LOCAL_STABLECOIN", "CRYPTO", "NATIVE_ASSET"],
  ProviderType: ["FX", "RAMP", "WALLET", "RPC", "MULTI_SERVICE"],
  CapabilityType: [
    "QUOTE",
    "SWAP",
    "EXACT_INPUT",
    "EXACT_OUTPUT",
    "ON_RAMP",
    "OFF_RAMP",
    "BANK_PAYOUT",
    "CONDITIONAL_EXECUTION",
  ],
  RouteStatus: ["CREATED", "VALID", "EXPIRED", "SELECTED", "INVALID"],
  RouteStepType: ["TRANSFER", "SWAP", "BRIDGE", "ON_RAMP", "OFF_RAMP", "BANK_PAYOUT"],
  ExecutionStatus: [
    "CREATED",
    "AWAITING_CONFIRMATION",
    "CONFIRMED",
    "EXECUTING",
    "SETTLING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "EXPIRED",
  ],
  TransactionType: ["APPROVAL", "TRANSFER", "SWAP", "CONTRACT_CALL", "RAMP"],
  TransactionStatus: [
    "CREATED",
    "SIGNING",
    "SUBMITTED",
    "CONFIRMING",
    "CONFIRMED",
    "FAILED",
    "REPLACED",
  ],
  RampType: ["ON_RAMP", "OFF_RAMP"],
  RampStatus: [
    "CREATED",
    "REDIRECT_REQUIRED",
    "PENDING",
    "PROCESSING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "EXPIRED",
  ],
};

/** Every canonical monetary column: smallest-unit integer strings. */
const moneyColumns: Record<string, string[]> = {
  Intent: ["amount"],
  Quote: ["inputAmount", "outputAmount", "feeAmount"],
  Route: ["estimatedInput", "estimatedOutput", "totalFeeAmount"],
  RouteStep: ["inputAmount", "outputAmount"],
  Transaction: ["amount", "gasAmount", "nonce"],
  RampSession: ["amount"],
};

describe("prisma schema", () => {
  it("defines every required model and enum", () => {
    assert.deepEqual([...models.keys()].sort(), [...modelNames].sort());
    assert.deepEqual([...enums.keys()].sort(), Object.keys(enumValues).sort());
    for (const [name, values] of Object.entries(enumValues)) {
      assert.deepEqual(enums.get(name), values, `enum ${name}`);
    }
  });

  it("never uses Float or Decimal", () => {
    for (const [model, fields] of models) {
      for (const field of fields) {
        assert.ok(!["Float", "Decimal"].includes(field.type), `${model}.${field.name}`);
      }
    }
  });

  it("stores every money column as a String", () => {
    for (const [model, columns] of Object.entries(moneyColumns)) {
      for (const column of columns) {
        const field = models.get(model)?.find((candidate) => candidate.name === column);
        assert.equal(field?.type, "String", `${model}.${column}`);
      }
    }
  });

  it("has no unlisted money-looking columns", () => {
    const listed = new Set(
      Object.entries(moneyColumns).flatMap(([model, columns]) =>
        columns.map((column) => `${model}.${column}`),
      ),
    );
    for (const [model, fields] of models) {
      for (const field of fields) {
        if (/(amount|estimatedInput|estimatedOutput|nonce)$/i.test(field.name)) {
          assert.ok(listed.has(`${model}.${field.name}`), `unlisted ${model}.${field.name}`);
        }
      }
    }
  });

  it("enforces integer-string format with a CHECK on every money column", () => {
    for (const [model, columns] of Object.entries(moneyColumns)) {
      assert.ok(constraints.includes(`ALTER TABLE "${model}"`), model);
      for (const column of columns) {
        assert.ok(constraints.includes(`"${column}" ~ '^(0|[1-9][0-9]*)$'`), `${model}.${column}`);
      }
    }
  });

  it("uses application-generated UUID primary keys", () => {
    for (const [model, fields] of models) {
      const id = fields.find((field) => field.name === "id");
      assert.ok(id, `${model}.id`);
      assert.equal(id.type, "String");
      assert.ok(id.attributes.includes("@id") && id.attributes.includes("@db.Uuid"), model);
      assert.ok(!id.attributes.includes("@default"), `${model}.id must not have a default`);
    }
    const code = schema.replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/autoincrement\(|cuid\(|uuid\(|dbgenerated\(/.test(code));
  });

  it("keeps foreign key columns as UUIDs", () => {
    const notForeignKeys = /^(external\w*|providerQuoteId|chainId)$/;
    for (const [model, fields] of models) {
      for (const field of fields) {
        if (field.name.endsWith("Id") && field.name !== "id" && !notForeignKeys.test(field.name)) {
          assert.ok(field.attributes.includes("@db.Uuid"), `${model}.${field.name}`);
        }
      }
    }
  });

  it("declares onDelete on every relation", () => {
    for (const line of schema.split("\n").filter((l) => l.includes("fields: ["))) {
      assert.match(line, /onDelete: (Restrict|Cascade|SetNull)/, line.trim());
    }
  });

  it("models quotes and audit events as immutable (no updatedAt)", () => {
    for (const model of ["Quote", "AuditEvent"]) {
      assert.ok(!models.get(model)?.some((field) => field.name === "updatedAt"), model);
    }
  });

  it("keeps idempotency keys and transaction hashes durably unique", () => {
    const key = models.get("Execution")?.find((field) => field.name === "idempotencyKey");
    assert.ok(key && !key.optional && key.attributes.includes("@unique"));
    assert.match(schema, /@@unique\(\[chainId, hash\]\)/);
  });

  it("versions intents and keeps the funding preference separate from the amount", () => {
    const intent = models.get("Intent");
    const revision = intent?.find((field) => field.name === "revision");
    assert.equal(revision?.type, "Int");
    assert.match(revision?.attributes ?? "", /@default\(1\)/);
    const preference = intent?.find((field) => field.name === "preferredSourceAssetId");
    assert.equal(preference?.type, "String");
    assert.ok(preference?.optional && preference.attributes.includes("@db.Uuid"));
  });

  it("stores clarification options server-side, bound to an intent revision", () => {
    const option = models.get("ClarificationOption");
    const names = option?.map((field) => field.name) ?? [];
    for (const field of [
      "groupId",
      "conversationId",
      "intentId",
      "revision",
      "value",
      "expiresAt",
      "usedAt",
    ]) {
      assert.ok(names.includes(field), field);
    }
    assert.equal(option?.find((field) => field.name === "value")?.type, "Json");
    assert.ok(option?.find((field) => field.name === "usedAt")?.optional);
  });

  it("keeps datasource URLs out of the schema (Prisma 7)", () => {
    assert.ok(!/^\s*(url|directUrl|shadowDatabaseUrl)\s*=/m.test(schema));
  });
});
