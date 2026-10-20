/**
 * AllowlistService — API-key, address and IP allowlisting for the abuse detector.
 *
 * Integrators behind shared IPs (e.g. wallets sending all traffic from a
 * single datacenter IP) would otherwise trip the ip_asn_cluster rule.
 * Allowlisting those partners bypasses the enforcement action while still
 * recording abuse signals for transparency.
 *
 * Two sources are checked, and an entry in either one allowlists the request:
 *
 * 1. `ABUSE_ALLOWLIST` env var (seed / fallback, parsed once at boot).
 *    Comma-separated list. Each entry is one of:
 *    - A Stellar user address (G…)
 *    - An exact IPv4/IPv6 address
 *    - An API key prefixed with "key:" (e.g. "key:mytoken")
 *    Example: ABUSE_ALLOWLIST=GABC...XYZ,192.0.2.10,key:integrator-prod-key
 *
 * 2. The `abuse_allowlist_entries` Postgres table (issue #605), managed live
 *    through `GET/POST/DELETE /api/v1/abuse/allowlist`. Rows are held in an
 *    in-memory cache so `isAllowlisted` never does I/O. After a change, the
 *    instance that made it publishes on a pub/sub channel (same transport as
 *    the feature-flag bus, `src/flags/flag-bus.ts`) and every other replica
 *    reloads. A periodic reload backs this up in case a message is lost.
 *
 * IP matching is exact-address only, in both sources. CIDR ranges are not
 * expanded: the admin API rejects them, and an env entry such as
 * "192.0.2.0/24" only matches a client IP that is literally that string.
 *
 * API keys are never stored raw: they are SHA-256 hashed before they reach the
 * in-memory set or the database.
 */

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { isIP } from "net";
import { PrismaService } from "../prisma/prisma.service";
import { AdminAuditService } from "../admin/admin-audit.service";
import { AdminPrincipal } from "../admin/admin-auth";
import { AppConfig } from "../config/configuration";
import { FlagBus, InMemoryFlagBus, RedisFlagBus } from "../flags/flag-bus";

/** Optional injection token to supply a custom bus (tests, shared in-process bus). */
export const ABUSE_ALLOWLIST_BUS = Symbol("ABUSE_ALLOWLIST_BUS");

/** Pub/sub channel carrying allowlist change notifications. */
export const ABUSE_ALLOWLIST_CHANNEL = "vortex:abuse:allowlist:changed";

export const ALLOWLIST_ENTRY_TYPES = ["address", "ip", "api_key"] as const;
export type AllowlistEntryType = (typeof ALLOWLIST_ENTRY_TYPES)[number];

/** A stored allowlist entry as returned by the admin API. */
export interface AllowlistEntryView {
  id: string;
  type: AllowlistEntryType;
  /** Lowercased address, exact IP, or SHA-256 hex digest for `api_key`. */
  value: string;
  label: string | null;
  createdAt: string;
  createdBy: string;
}

export interface AllowlistListing {
  entries: AllowlistEntryView[];
  /** How many entries came from the ABUSE_ALLOWLIST env var (not editable via the API). */
  envSeed: { addresses: number; ips: number; apiKeys: number };
}

interface EntrySets {
  addresses: ReadonlySet<string>;
  ips: ReadonlySet<string>;
  keyDigests: ReadonlySet<string>;
}

const EMPTY_SETS: EntrySets = { addresses: new Set(), ips: new Set(), keyDigests: new Set() };

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

@Injectable()
export class AllowlistService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AllowlistService.name);
  private readonly instanceId = randomUUID();

  /** Entries parsed from ABUSE_ALLOWLIST at boot. */
  private readonly envEntries: EntrySets;
  /** Last successfully loaded Postgres entries (replaced whole on each reload). */
  private dbEntries: EntrySets = EMPTY_SETS;

  private readonly bus?: FlagBus;
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly config?: ConfigService<AppConfig, true>,
    @Optional() private readonly audit?: AdminAuditService,
    @Optional() @Inject(ABUSE_ALLOWLIST_BUS) bus?: FlagBus,
  ) {
    this.envEntries = this.parseEnv(process.env.ABUSE_ALLOWLIST ?? "");

    const abuse = config?.get("abuse", { infer: true });
    this.bus =
      bus ??
      (abuse?.allowlistPubsub === "redis"
        ? new RedisFlagBus(config!.get("redisUrl", { infer: true }), ABUSE_ALLOWLIST_CHANNEL)
        : new InMemoryFlagBus(ABUSE_ALLOWLIST_CHANNEL));
  }

  async onModuleInit(): Promise<void> {
    if (!this.prisma) return;
    await this.reload();
    try {
      await this.bus?.subscribe((msg) => {
        if (msg.origin !== this.instanceId) void this.reload();
      });
    } catch (err) {
      this.logger.warn(`[allowlist] pub/sub subscribe failed, relying on periodic reload: ${(err as Error).message}`);
    }
    const refreshMs = this.config?.get("abuse", { infer: true })?.allowlistRefreshMs ?? 30_000;
    if (refreshMs > 0) {
      this.refreshTimer = setInterval(() => void this.reload(), refreshMs);
      this.refreshTimer.unref?.();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.bus?.close();
  }

  /**
   * Returns true if the request is allowlisted and enforcement should be
   * suppressed (signals are still scored and logged). Reads only memory.
   */
  isAllowlisted(opts: { userAddress: string; clientIp: string; apiKey?: string }): boolean {
    const address = opts.userAddress.toLowerCase();
    const ip = opts.clientIp.toLowerCase();
    const digest = opts.apiKey ? this.digest(opts.apiKey) : undefined;
    for (const sets of [this.envEntries, this.dbEntries]) {
      if (sets.addresses.has(address)) return true;
      if (sets.ips.has(ip)) return true;
      if (digest && sets.keyDigests.has(digest)) return true;
    }
    return false;
  }

  /**
   * Reload the Postgres entries into memory. On failure the last loaded set is
   * kept, so a database blip neither drops nor invents allowlist entries.
   */
  async reload(): Promise<void> {
    if (!this.prisma) return;
    try {
      const rows = await this.prisma.abuseAllowlistEntry.findMany({ select: { type: true, value: true } });
      const addresses = new Set<string>();
      const ips = new Set<string>();
      const keyDigests = new Set<string>();
      for (const row of rows) {
        if (row.type === "address") addresses.add(row.value);
        else if (row.type === "ip") ips.add(row.value);
        else keyDigests.add(row.value);
      }
      this.dbEntries = { addresses, ips, keyDigests };
    } catch (err) {
      this.logger.warn(`[allowlist] reload from Postgres failed, keeping last known entries: ${(err as Error).message}`);
    }
  }

  async list(): Promise<AllowlistListing> {
    const prisma = this.requirePrisma();
    const rows = await prisma.abuseAllowlistEntry.findMany({ orderBy: { createdAt: "desc" } });
    return {
      entries: rows.map(toView),
      envSeed: {
        addresses: this.envEntries.addresses.size,
        ips: this.envEntries.ips.size,
        apiKeys: this.envEntries.keyDigests.size,
      },
    };
  }

  /** Add an entry, audited, and propagate it to every replica. */
  async add(
    input: { type: AllowlistEntryType; value: string; label?: string },
    admin: AdminPrincipal,
  ): Promise<AllowlistEntryView> {
    const prisma = this.requirePrisma();
    const value = this.normalize(input.type, input.value);
    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const row = await tx.abuseAllowlistEntry.create({
          data: { type: input.type, value, label: input.label ?? null, createdBy: admin.id },
        });
        await this.audit?.record(
          {
            actor: admin.id,
            action: "abuse.allowlist.add",
            target: `abuse-allowlist:${row.id}`,
            after: { type: row.type, value: row.value, label: row.label },
          },
          tx,
        );
        return row;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException(`An ${input.type} allowlist entry with that value already exists`);
      }
      throw err;
    }
    await this.applyChange();
    return toView(created);
  }

  /** Remove an entry, audited, and propagate the removal to every replica. */
  async remove(id: string, admin: AdminPrincipal): Promise<AllowlistEntryView> {
    const prisma = this.requirePrisma();
    let removed;
    try {
      removed = await prisma.$transaction(async (tx) => {
        const row = await tx.abuseAllowlistEntry.delete({ where: { id } });
        await this.audit?.record(
          {
            actor: admin.id,
            action: "abuse.allowlist.remove",
            target: `abuse-allowlist:${row.id}`,
            before: { type: row.type, value: row.value, label: row.label },
          },
          tx,
        );
        return row;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new NotFoundException(`Allowlist entry ${id} not found`);
      }
      throw err;
    }
    await this.applyChange();
    return toView(removed);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Reload locally, then tell the other replicas to do the same. */
  private async applyChange(): Promise<void> {
    await this.reload();
    try {
      await this.bus?.publish({ key: "abuse-allowlist", version: Date.now(), origin: this.instanceId });
    } catch (err) {
      this.logger.warn(`[allowlist] change publish failed, replicas pick it up on the next reload: ${(err as Error).message}`);
    }
  }

  /** Validate an admin-supplied value and convert it to its stored form. */
  private normalize(type: AllowlistEntryType, raw: string): string {
    const value = raw.trim();
    switch (type) {
      case "address":
        if (!STELLAR_ADDRESS.test(value.toUpperCase())) {
          throw new BadRequestException("value must be a Stellar account address (G…, 56 characters)");
        }
        return value.toLowerCase();
      case "ip":
        if (isIP(value) === 0) {
          throw new BadRequestException("value must be an exact IPv4 or IPv6 address; CIDR ranges are not supported");
        }
        return value.toLowerCase();
      case "api_key":
        if (value.length === 0) throw new BadRequestException("value must be a non-empty API key");
        return this.digest(value);
    }
  }

  private requirePrisma(): PrismaService {
    if (!this.prisma) throw new ServiceUnavailableException("Allowlist persistence is not configured");
    return this.prisma;
  }

  private parseEnv(raw: string): EntrySets {
    const addresses = new Set<string>();
    const ips = new Set<string>();
    const keyDigests = new Set<string>();

    for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
      if (entry.startsWith("key:")) {
        keyDigests.add(this.digest(entry.slice(4)));
      } else if (entry.startsWith("G")) {
        // Stellar account IDs start with G (contracts C, muxed M never do),
        // so a G-prefix alone classifies the entry as an address.
        addresses.add(entry.toLowerCase());
      } else {
        // Everything else is treated as an exact IP address.
        ips.add(entry.toLowerCase());
      }
    }

    const total = addresses.size + ips.size + keyDigests.size;
    if (total > 0) {
      this.logger.log(
        `[allowlist] Loaded ${addresses.size} addresses, ${ips.size} IPs, ${keyDigests.size} API keys from ABUSE_ALLOWLIST`,
      );
    }
    return { addresses, ips, keyDigests };
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

function toView(row: {
  id: string;
  type: AllowlistEntryType;
  value: string;
  label: string | null;
  createdAt: Date;
  createdBy: string;
}): AllowlistEntryView {
  return {
    id: row.id,
    type: row.type,
    value: row.value,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}
