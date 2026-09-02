import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SupportedChain } from "../intents/intents.types";
import { ITokensRepository, TokenRecord } from "./tokens.repository";

@Injectable()
export class PrismaTokensRepository implements ITokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<TokenRecord[]> {
    const rows = await this.prisma.token.findMany();
    return rows.map((row) => this.fromRow(row));
  }

  async findByChain(chain: SupportedChain | string): Promise<TokenRecord[]> {
    const rows = await this.prisma.token.findMany({
      where: { chain: (chain as SupportedChain) ?? "stellar" },
    });
    return rows.map((row) => this.fromRow(row));
  }

  async findByAddressAndChain(
    address: string,
    chain: SupportedChain | string,
  ): Promise<TokenRecord | undefined> {
    const row = await this.prisma.token.findFirst({
      where: {
        address,
        chain: chain as SupportedChain,
      },
    });
    return row ? this.fromRow(row) : undefined;
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
