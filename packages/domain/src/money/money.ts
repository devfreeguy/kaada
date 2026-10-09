import { KaadaError } from "../errors/index.js";
import { amountToBigInt, assertSmallestUnitAmount, bigIntToAmount } from "./amount.js";
import { parseHumanAmount } from "./human-amount.js";

/** Canonical money: a smallest-unit integer string tied to the asset that defines its meaning. */
export interface Money {
  readonly amount: string;
  readonly assetId: string;
}

export function createMoney(amount: string, assetId: string): Money {
  assertSmallestUnitAmount(amount);
  if (typeof assetId !== "string" || assetId.length === 0) {
    throw new KaadaError("ASSET_MISMATCH", "money requires an asset id");
  }
  return { amount, assetId };
}

/** Resolves a human decimal string against a known asset. Rejects anything needing rounding. */
export function moneyFromHuman(value: string, asset: { id: string; decimals: number }): Money {
  return createMoney(parseHumanAmount(value, asset.decimals), asset.id);
}

export function isZeroMoney(money: Money): boolean {
  return amountToBigInt(money.amount) === 0n;
}

function assertSameAsset(a: Money, b: Money): void {
  if (a.assetId !== b.assetId) {
    throw new KaadaError("ASSET_MISMATCH", "cannot combine money of different assets", {
      details: { left: a.assetId, right: b.assetId },
    });
  }
}

/** -1, 0 or 1. Throws ASSET_MISMATCH for different assets. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameAsset(a, b);
  const left = amountToBigInt(a.amount);
  const right = amountToBigInt(b.amount);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  const sum = amountToBigInt(a.amount) + amountToBigInt(b.amount);
  return { assetId: a.assetId, amount: bigIntToAmount(sum) };
}

/** Throws INSUFFICIENT_AMOUNT when b is larger than a; negative money does not exist. */
export function subtractMoney(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  const difference = amountToBigInt(a.amount) - amountToBigInt(b.amount);
  if (difference < 0n) {
    throw new KaadaError("INSUFFICIENT_AMOUNT", "subtraction would produce a negative amount", {
      details: { assetId: a.assetId },
    });
  }
  return { assetId: a.assetId, amount: bigIntToAmount(difference) };
}

export function minMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) <= 0 ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) >= 0 ? a : b;
}
