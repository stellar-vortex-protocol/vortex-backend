import { createHmac, createHash } from "crypto";

/**
 * Rotating-salt pseudonymisation for user addresses.
 *
 * Policy (see docs/rfcs/0001-public-anonymised-datasets.md): user addresses are
 * hashed with HMAC-SHA256 keyed by a salt that rotates on a fixed cadence.  The
 * base salt is a deploy secret and is never written to any exported artifact.
 * A small number of previous salt windows are retained so within-window
 * aggregation stays possible, while the rotation bounds cross-window linking.
 */

/**
 * Derive the per-window salt from the base salt and a window index.  The base
 * salt never appears in any output; each window salt is an independent HMAC
 * digest so an attacker who learns one window salt cannot recover the base or
 * other windows.
 */
export function deriveWindowSalt(baseSalt: string, windowIndex: number): string {
  return createHmac("sha256", baseSalt).update(String(windowIndex)).digest("hex");
}

/** Compute the rotation window index a unix-epoch timestamp falls into. */
export function windowIndexFor(timestampMs: number, windowMs: number): number {
  return Math.floor(timestampMs / windowMs);
}

/**
 * Pseudonymise an address with a specific window salt.
 * Deterministic: the same (address, salt) always yields the same id.
 */
export function hashAddress(address: string, windowSalt: string): string {
  return createHmac("sha256", windowSalt).update(address).digest("hex");
}

/**
 * A stateful anonymiser that derives window salts from a base salt and keeps a
 * bounded history of recent windows so late data can still be matched to the
 * window it belongs to.
 */
export class Anonymizer {
  private readonly windowMs: number;
  private readonly cache = new Map<number, string>();

  constructor(
    private readonly baseSalt: string,
    rotationHours: number,
    private readonly retentionWindows: number,
  ) {
    this.windowMs = rotationHours * 3_600_000;
  }

  /** Active window salt for a timestamp (deriving and caching on demand). */
  saltFor(timestampMs: number): string {
    const index = windowIndexFor(timestampMs, this.windowMs);
    return this.windowSalt(index);
  }

  /** Look up (or derive + cache) the salt for a specific window index. */
  windowSalt(index: number): string {
    const cached = this.cache.get(index);
    if (cached) return cached;
    const salt = deriveWindowSalt(this.baseSalt, index);
    this.cache.set(index, salt);
    this.prune(index);
    return salt;
  }

  /** Pseudonymise an address for a given timestamp. */
  hash(address: string, timestampMs: number): string {
    return hashAddress(address, this.saltFor(timestampMs));
  }

  /** Deterministic id for a given address at a given timestamp (no timing). */
  hashFor(address: string, timestampMs: number): string {
    return hashAddress(address, this.saltFor(timestampMs));
  }

  private prune(latestIndex: number): void {
    const floor = latestIndex - this.retentionWindows;
    for (const key of this.cache.keys()) {
      if (key < floor) this.cache.delete(key);
    }
  }
}

/** Unkeyed SHA-256 hex digest — used for content checksums, not identities. */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
