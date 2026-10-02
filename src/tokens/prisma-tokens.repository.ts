import { Injectable } from "@nestjs/common";
import { TokenStatus as PrismaTokenStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SupportedChain } from "../intents/intents.types";
import { ITokensRepository, TokenAssetKind, TokenRecord, TokenStatus } from "./tokens.repository";

@Injectable()
export class PrismaTokensRepository implements ITokensRepository {
  private records: TokenRecord[] = [];
  private generation = 0;

  constructor(private readonly prisma: PrismaService) {}

  async init(): Promise<void> {
    const rows = await this.prisma.token.findMany();
    this.records = rows.map((row) => this.fromRow(row));
  }

  findAll(): TokenRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  findByChain(chain: SupportedChain | string): TokenRecord[] {
    const normalized = String(chain).toLowerCase();
    return this.records
      .filter((record) => record.chain === normalized || record.chain === chain)
      .map((record) => ({ ...record }));
  }

  findByAddressAndChain(address: string, chain: SupportedChain | string): TokenRecord | undefined {
    const normalizedAddress = address.trim().toLowerCase();
    const chainName = String(chain).toLowerCase();
    const match = this.records.find(
      (record) => record.address.toLowerCase() === normalizedAddress && record.chain === chainName,
    );
    return match ? { ...match } : undefined;
  }

  /** Persist, then replace the in-memory snapshot so readers see the write. */
  async save(record: TokenRecord): Promise<TokenRecord> {
    const status = (record.status ?? "active") as PrismaTokenStatus;
    const data = {
      address: record.address,
      symbol: record.symbol,
      name: record.name,
      decimals: record.decimals,
      chain: record.chain,
      logoUri: record.logoUri ?? null,
      priceUsd: record.priceUsd ?? null,
      isStellar: record.isStellar,
      status,
      assetKind: record.assetKind ?? (record.isStellar ? "stellar-sac" : "evm"),
    };
    await this.prisma.token.upsert({
      where: { address_chain: { address: record.address, chain: record.chain } },
      create: data,
      update: data,
    });
    await this.init();
    this.generation += 1;
    return this.findByAddressAndChain(record.address, record.chain) ?? { ...record, status: record.status ?? "active" };
  }

  async setStatus(
    address: string,
    chain: SupportedChain | string,
    status: TokenStatus,
  ): Promise<TokenRecord | undefined> {
    const existing = this.findByAddressAndChain(address, chain);
    if (!existing) return undefined;
    return this.save({ ...existing, status });
  }

  cacheGeneration(): number {
    return this.generation;
  }

  private fromRow(row: {
    id?: string;
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    chain: SupportedChain;
    logoUri?: string | null;
    priceUsd?: number | null;
    isStellar: boolean;
    status?: PrismaTokenStatus;
    assetKind?: string;
  }): TokenRecord {
    return {
      id: row.id,
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      chain: row.chain,
      logoUri: row.logoUri ?? null,
      priceUsd: row.priceUsd ?? null,
      isStellar: row.isStellar,
      status: row.status ?? "active",
      assetKind: (row.assetKind as TokenAssetKind | undefined) ?? (row.isStellar ? "stellar-sac" : "evm"),
    };
  }
}
