import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ISolversRepository } from "./solvers.repository";
import { SolverRecord } from "./solvers.types";
import { Prisma } from "@prisma/client";
import {
  epochToDate,
  EpochTimestampOptions,
  readEpoch,
  TimestampReadSource,
} from "../prisma/epoch-timestamps";

/**
 * Prisma-backed implementation of ISolversRepository.
 *
 * `save()` uses an upsert keyed on the solver's unique address so that
 * `register()`, `deactivate()`, `reactivate()`, and `recordFailedFill()`
 * in SolversService all continue to work without any modifications.
 *
 * Bigint amounts (bondAmount, totalVolume) remain strings throughout —
 * never coerced through a JS number — per the project's bigint-as-string
 * convention (see CONTRIBUTING.md).
 *
 * JSON columns (supportedChains, supportedTokens) are stored/retrieved
 * consistently with InMemorySolversRepository: the raw TypeScript arrays
 * are serialised to JSON by Prisma and deserialised back to the same shapes.
 *
 * `registeredAt` / `lastActiveAt` are written to both their epoch INTEGER
 * columns and timestamptz twins, and read from the column selected by
 * `TIMESTAMP_READ_SOURCE` (issue #409). The API keeps epoch seconds.
 */
@Injectable()
export class PrismaSolversRepository implements ISolversRepository {
  private readonly readSource: TimestampReadSource;

  constructor(
    private readonly prisma: PrismaService,
    options: EpochTimestampOptions = {},
  ) {
    this.readSource = options.timestampReadSource ?? "epoch";
  }

  save(solver: SolverRecord): Promise<SolverRecord> {
    const data = this.toDbData(solver);
    return this.prisma.solver
      .upsert({
        where: { address: solver.address },
        create: { address: solver.address, ...data },
        update: data,
      })
      .then((row) => this.fromRow(row));
  }

  async findByAddress(address: string): Promise<SolverRecord | undefined> {
    const row = await this.prisma.solver.findUnique({ where: { address } });
    return row ? this.fromRow(row) : undefined;
  }

  async findAll(): Promise<SolverRecord[]> {
    const rows = await this.prisma.solver.findMany();
    return rows.map((r) => this.fromRow(r));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private toDbData(
    solver: SolverRecord,
  ): Omit<Prisma.SolverCreateInput, "address"> {
    return {
      name: solver.name,
      bondAmount: solver.bondAmount,
      fillsCompleted: solver.fillsCompleted,
      fillsFailed: solver.fillsFailed,
      totalVolume: solver.totalVolume,
      avgFillTime: solver.avgFillTime,
      isActive: solver.isActive,
      registeredAt: solver.registeredAt,
      registeredAtTs: epochToDate(solver.registeredAt),
      lastActiveAt: solver.lastActiveAt,
      lastActiveAtTs: epochToDate(solver.lastActiveAt),
      supportedChains: solver.supportedChains as unknown as Prisma.InputJsonValue,
      supportedTokens: solver.supportedTokens as unknown as Prisma.InputJsonValue,
      source: solver.source ?? "api",
      chainUpdatedLedger: solver.chainUpdatedLedger ?? null,
    };
  }

  private fromRow(row: {
    address: string;
    name: string;
    bondAmount: string;
    fillsCompleted: number;
    fillsFailed: number;
    totalVolume: string;
    avgFillTime: number;
    isActive: boolean;
    registeredAt: number;
    lastActiveAt: number;
    registeredAtTs?: Date | null;
    lastActiveAtTs?: Date | null;
    supportedChains: Prisma.JsonValue;
    supportedTokens: Prisma.JsonValue;
    source?: string | null;
    chainUpdatedLedger?: number | null;
  }): SolverRecord {
    return {
      address: row.address,
      name: row.name,
      bondAmount: row.bondAmount,
      fillsCompleted: row.fillsCompleted,
      fillsFailed: row.fillsFailed,
      totalVolume: row.totalVolume,
      avgFillTime: row.avgFillTime,
      isActive: row.isActive,
      registeredAt: readEpoch(this.readSource, row.registeredAt, row.registeredAtTs) ?? row.registeredAt,
      lastActiveAt: readEpoch(this.readSource, row.lastActiveAt, row.lastActiveAtTs) ?? row.lastActiveAt,
      supportedChains: row.supportedChains as SolverRecord["supportedChains"],
      supportedTokens: row.supportedTokens as SolverRecord["supportedTokens"],
      source: (row.source as SolverRecord["source"]) ?? "api",
      chainUpdatedLedger: row.chainUpdatedLedger ?? null,
    };
  }
}
