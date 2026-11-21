import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from './tokens.service';
import { ApiToken } from './dto/api-token.dto';

export const MAX_WATCHLIST_ENTRIES = 50;

export interface WatchlistEntry {
  chain: string;
  address: string;
}

@Injectable()
export class WatchlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokensService: TokensService,
  ) {}

  async getWatchlist(userAddress: string): Promise<ApiToken[]> {
    const entries = await this.prisma.tokenWatchlist.findMany({
      where: { userAddress },
      orderBy: { createdAt: 'asc' },
    });

    if (entries.length === 0) {
      return [];
    }

    const resolved: ApiToken[] = [];
    for (const entry of entries) {
      const token = await this.tokensService.findByChainAndAddress(
        entry.chain,
        entry.address,
      );
      if (!token) {
        // Delisted/unknown tokens stay stored but are excluded from the
        // resolved response, consistent with hideDelisted() semantics.
        continue;
      }
      resolved.push(token);
    }

    return resolved;
  }

  async replaceWatchlist(
    userAddress: string,
    entries: WatchlistEntry[],
  ): Promise<ApiToken[]> {
    if (entries.length > MAX_WATCHLIST_ENTRIES) {
      throw new BadRequestException(
        `Watchlist may contain at most ${MAX_WATCHLIST_ENTRIES} entries`,
      );
    }

    const seen = new Set<string>();
    const deduped: WatchlistEntry[] = [];
    for (const entry of entries) {
      const key = `${entry.chain}:${entry.address}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(entry);
    }

    // Validate every reference against the live registry before persisting.
    for (const entry of deduped) {
      const token = await this.tokensService.findByChainAndAddress(
        entry.chain,
        entry.address,
      );
      if (!token) {
        throw new BadRequestException(
          `Unknown token reference: ${entry.chain}:${entry.address}`,
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.tokenWatchlist.deleteMany({ where: { userAddress } }),
      this.prisma.tokenWatchlist.createMany({
        data: deduped.map((entry) => ({
          userAddress,
          chain: entry.chain,
          address: entry.address,
        })),
      }),
    ]);

    return this.getWatchlist(userAddress);
  }
}
