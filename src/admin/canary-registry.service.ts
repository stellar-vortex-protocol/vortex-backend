import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface CanaryAddressRecord {
  address: string;
  addedAt: Date;
  addedBy: string;
}

/**
 * Runtime-manageable registry of synthetic canary addresses.
 *
 * Backed by the `canary_addresses` Postgres table. Reads are served from a
 * short-TTL in-memory cache (mirroring `src/flags/flag-registry.ts`) so that
 * stats requests do not hit Postgres on every call, while still picking up
 * admin changes within one TTL window.
 *
 * The `CANARY_ADDRESSES` env var is only used as a bootstrap seed: it is
 * applied once on first boot when the table is empty.
 */
@Injectable()
export class CanaryRegistryService implements OnModuleInit {
  private static readonly CACHE_TTL_MS = 5_000;

  private readonly logger = new Logger(CanaryRegistryService.name);

  private cachedAddresses: ReadonlySet<string> | null = null;
  private cacheExpiresAt = 0;
  private inFlightLoad: Promise<ReadonlySet<string>> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedIfEmpty();
    } catch (error) {
      this.logger.error(
        `Failed to seed canary addresses from configuration: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Returns the current set of canary addresses, served from cache when fresh.
   * Removals/additions are visible within one TTL window.
   */
  async getAddresses(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (this.cachedAddresses && now < this.cacheExpiresAt) {
      return this.cachedAddresses;
    }

    // Coalesce concurrent refreshes so a burst of stats requests only triggers
    // a single DB read.
    if (!this.inFlightLoad) {
      this.inFlightLoad = this.loadFromDb().finally(() => {
        this.inFlightLoad = null;
      });
    }

    return this.inFlightLoad;
  }

  async list(): Promise<CanaryAddressRecord[]> {
    const rows = await this.prisma.canaryAddress.findMany({
      orderBy: { addedAt: 'asc' },
    });
    return rows.map((row) => ({
      address: row.address,
      addedAt: row.addedAt,
      addedBy: row.addedBy,
    }));
  }

  async add(address: string, addedBy: string): Promise<CanaryAddressRecord> {
    const normalized = this.normalize(address);
    const row = await this.prisma.canaryAddress.upsert({
      where: { address: normalized },
      update: {},
      create: { address: normalized, addedBy },
    });

    // Invalidate the cache so the new address is visible on the next read.
    this.invalidate();

    return {
      address: row.address,
      addedAt: row.addedAt,
      addedBy: row.addedBy,
    };
  }

  async remove(address: string): Promise<boolean> {
    const normalized = this.normalize(address);

    // Invalidate *before* the delete so that any read that starts after this
    // point cannot be served from a snapshot that still contains the address.
    this.invalidate();

    const result = await this.prisma.canaryAddress.deleteMany({
      where: { address: normalized },
    });

    // Invalidate again after the delete completes so that a read that raced
    // with the delete (and repopulated the cache from the pre-delete state)
    // is discarded.
    this.invalidate();

    return result.count > 0;
  }

  async has(address: string): Promise<boolean> {
    const addresses = await this.getAddresses();
    return addresses.has(this.normalize(address));
  }

  private async loadFromDb(): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.canaryAddress.findMany({
      select: { address: true },
    });
    const addresses = new Set(rows.map((row) => row.address));

    this.cachedAddresses = addresses;
    this.cacheExpiresAt = Date.now() + CanaryRegistryService.CACHE_TTL_MS;

    return addresses;
  }

  private invalidate(): void {
    this.cachedAddresses = null;
    this.cacheExpiresAt = 0;
  }

  private async seedIfEmpty(): Promise<void> {
    const count = await this.prisma.canaryAddress.count();
    if (count > 0) {
      return;
    }

    const configured = this.configService.get<string[]>('canaryAddresses') ?? [];
    const seeds = Array.from(
      new Set(
        configured
          .map((address) => this.normalize(address))
          .filter((address) => address.length > 0),
      ),
    );

    if (seeds.length === 0) {
      return;
    }

    await this.prisma.canaryAddress.createMany({
      data: seeds.map((address) => ({ address, addedBy: 'bootstrap' })),
      skipDuplicates: true,
    });

    this.invalidate();

    this.logger.log(
      `Seeded ${seeds.length} canary address(es) from CANARY_ADDRESSES configuration`,
    );
  }

  private normalize(address: string): string {
    return address.trim();
  }
}