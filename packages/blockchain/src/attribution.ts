import { concat, stringToHex } from "viem";
import type { Hex } from "viem";

/**
 * Celo ERC-8021 attribution (https://github.com/celo-org/attribution-tags), schema 0: the code's ASCII bytes, a one-byte length,
 * the schema id 0x00, and the 16-byte marker, appended to the END of calldata. The EVM ignores it; indexers read it back.
 * This is the same encoding the official `toDataSuffix` produces (pinned by a test vector) and the one the Kernel adapter's
 * `attributionSuffix` carries inside each UserOperation's callData.
 */
export const CELO_ATTRIBUTION_CODE = "celo_51c4a2ae2240";
export const ERC_8021_MARKER: Hex = "0x80218021802180218021802180218021";

export function attributionSuffix(code: string = CELO_ATTRIBUTION_CODE): Hex {
  if (!/^[a-z0-9_]{1,32}$/.test(code))
    throw new Error("an attribution code is 1-32 of a-z, 0-9, _");
  return concat([
    stringToHex(code),
    `0x${code.length.toString(16).padStart(2, "0")}`,
    "0x00",
    ERC_8021_MARKER,
  ]);
}

/** `data` with the suffix at its end; data that already ends with an ERC-8021 marker is left alone (never tagged twice). */
export function withAttribution(data: Hex | undefined, suffix: Hex = attributionSuffix()): Hex {
  const base = data ?? "0x";
  return base.toLowerCase().endsWith(ERC_8021_MARKER.slice(2)) ? base : concat([base, suffix]);
}
