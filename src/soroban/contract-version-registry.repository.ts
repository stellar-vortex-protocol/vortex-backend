import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * A single persisted contract-version registry entry: a WASM hash that has
 * been reviewed and registered as supported for a given contract, together
 * with the ABI version the backend codec encodes for it.
 */
export interface ContractVersionRegistryEntry {
  contract: string;
  wasmHash: string;
  abiVersion: string;
}

/**
 * Persistent backing store for the runtime-manageable contract-version
 * registry. `ContractVersionService` loads these entries into its in-memory
 * map so `assertWritable`'s hot path stays a synchronous lookup.
 */
@Injectable()
export class ContractVersionRegistryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<ContractVersionRegistryEntry[]> {
    const rows = await this.prisma.contractVersionRegistry.findMany({
      select: { contract: true, wasmHash: true, abiVersion: true },
    });
    return rows.map((row) => ({
      contract: row.contract,
      wasmHash: row.wasmHash,
      abiVersion: row.abiVersion,
    }));
  }

  async upsert(
    entry: ContractVersionRegistryEntry,
  ): Promise<ContractVersionRegistryEntry> {
    const row = await this.prisma.contractVersionRegistry.upsert({
      where: {
        contract_wasmHash: {
          contract: entry.contract,
          wasmHash: entry.wasmHash,
        },
      },
      create: {
        contract: entry.contract,
        wasmHash: entry.wasmHash,
        abiVersion: entry.abiVersion,
      },
      update: { abiVersion: entry.abiVersion },
      select: { contract: true, wasmHash: true, abiVersion: true },
    });
    return {
      contract: row.contract,
      wasmHash: row.wasmHash,
      abiVersion: row.abiVersion,
    };
  }

  async delete(contract: string, wasmHash: string): Promise<boolean> {
    const result = await this.prisma.contractVersionRegistry.deleteMany({
      where: { contract, wasmHash },
    });
    return result.count > 0;
  }
}
