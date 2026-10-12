import type { AndroidRevocationSource } from "@kaada/attestation";

export interface GoogleRevocationListOptions {
  /** https://android.googleapis.com/attestation/status */
  url: string;
  /** How long a fetched list is used before it is refreshed. */
  cacheMs: number;
  /** How long a list may be used when a refresh fails. Beyond it nothing can be checked, so evidence is refused. */
  staleMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface Snapshot {
  fetchedAt: number;
  /** Lower-case hex serials without leading zeros, and decimal serials, both: Google's list uses both spellings. */
  revoked: Set<string>;
}

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Google's list of revoked Android attestation certificates. Used FAIL-CLOSED: when the list cannot be fetched and no
 * recent copy exists, `isRevoked` throws, and the verifier then refuses the evidence rather than guessing "not revoked".
 */
export class GoogleRevocationList implements AndroidRevocationSource {
  private snapshot: Snapshot | null = null;
  private refreshing: Promise<Snapshot> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: GoogleRevocationListOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async isRevoked(serialHex: string): Promise<boolean> {
    const { revoked } = await this.current();
    if (!/^[0-9a-f]+$/.test(serialHex)) throw new Error("malformed certificate serial");
    return revoked.has(serialHex) || revoked.has(BigInt(`0x${serialHex}`).toString(10));
  }

  private async current(): Promise<Snapshot> {
    const now = this.now().getTime();
    const held = this.snapshot;
    if (held && now - held.fetchedAt < this.options.cacheMs) return held;
    // One refresh at a time, however many verifications are waiting.
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    try {
      return await this.refreshing;
    } catch (error) {
      if (held && now - held.fetchedAt < (this.options.staleMs ?? DEFAULT_STALE_MS)) return held;
      throw error;
    }
  }

  private async refresh(): Promise<Snapshot> {
    const response = await this.fetchImpl(this.options.url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`revocation list answered ${String(response.status)}`);
    const body = (await response.json()) as { entries?: Record<string, unknown> };
    if (!body.entries || typeof body.entries !== "object") {
      throw new Error("revocation list has no entries");
    }
    const revoked = new Set<string>();
    for (const key of Object.keys(body.entries)) {
      const normal = key.trim().toLowerCase();
      revoked.add(normal.replace(/^0+(?=.)/, ""));
    }
    const snapshot = { fetchedAt: this.now().getTime(), revoked };
    this.snapshot = snapshot;
    return snapshot;
  }
}
