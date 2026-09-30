import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SupportedChain } from "../intents/intents.types";
import { ITokensRepository, TokenRecord } from "./tokens.repository";

@Injectable()
export class PrismaTokensRepository implements ITokensRepository {
  private records: TokenRecord[] = [];

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
      (record) =>
        record.address.toLowerCase() === normalizedAddress && record.chain === chainName,
    );
    return match ? { ...match } : undefined;
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
    };
  }
}
