/**
 * AllowlistService — API-key and address allowlisting for the abuse detector.
 *
 * Integrators behind shared IPs (e.g. wallets sending all traffic from a
 * single datacenter IP) would otherwise trip the ip_asn_cluster rule.
 * Providing a higher-tier API key to those partners bypasses the enforcement
 * action while still recording abuse signals for transparency.
 *
 * Config format (env var ABUSE_ALLOWLIST):
 *   Comma-separated list of entries.  Each entry is one of:
 *   - A Stellar user address (G…)
 *   - An IPv4/v6 CIDR or exact address
 *   - An API key prefixed with "key:" (e.g. "key:mytoken")
 *
 * Example:
 *   ABUSE_ALLOWLIST=GABC...XYZ,192.0.2.0/24,key:integrator-prod-key
 */

import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";

@Injectable()
export class AllowlistService {
  private readonly logger = new Logger(AllowlistService.name);

  /** Lowercased Stellar addresses that are always allowed. */
  private readonly addresses: ReadonlySet<string>;
  /** Exact IP strings that are always allowed. */
  private readonly ips: ReadonlySet<string>;
  /** SHA-256 digests of allowed API keys (never store raw keys). */
  private readonly keyDigests: ReadonlySet<string>;

  constructor() {
    const raw = process.env.ABUSE_ALLOWLIST ?? "";
    const addresses = new Set<string>();
    const ips = new Set<string>();
    const keyDigests = new Set<string>();

    for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
      if (entry.startsWith("key:")) {
        keyDigests.add(this.digest(entry.slice(4)));
      } else if (entry.startsWith("G") && entry.length >= 32) {
        // Stellar address heuristic: starts with G and is at least 32 chars
        addresses.add(entry.toLowerCase());
      } else {
        // Everything else is treated as an IP / CIDR
        ips.add(entry);
      }
    }

    this.addresses = addresses;
    this.ips = ips;
    this.keyDigests = keyDigests;

    const total = addresses.size + ips.size + keyDigests.size;
    if (total > 0) {
      this.logger.log(
        `[allowlist] Loaded ${addresses.size} addresses, ${ips.size} IPs, ${keyDigests.size} API keys`,
      );
    }
  }

  /**
   * Returns true if the request is allowlisted and enforcement should be
   * suppressed (signals are still scored and logged).
   */
  isAllowlisted(opts: {
    userAddress: string;
    clientIp: string;
    apiKey?: string;
  }): boolean {
    if (this.addresses.has(opts.userAddress.toLowerCase())) return true;
    if (this.ips.has(opts.clientIp)) return true;
    if (opts.apiKey && this.keyDigests.has(this.digest(opts.apiKey))) return true;
    return false;
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
