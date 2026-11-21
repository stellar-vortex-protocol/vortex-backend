import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiToken } from "./tokens.service";
import { WatchlistEntry, WatchlistService } from "./watchlist.service";

interface PutWatchlistBody {
  tokens?: WatchlistEntry[];
}

/**
 * Per-user token watchlist endpoints (issue #655).
 *
 * Keyed by the user's Stellar/EVM address, matching the address-as-identity
 * convention used by intent creation. No signature-based auth is assumed.
 */
@Controller("api/v1/users/:address/watchlist")
export class WatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Put()
  async replace(
    @Param("address") address: string,
    @Body() body: PutWatchlistBody,
  ): Promise<{ tokens: WatchlistEntry[] }> {
    const tokens = await this.watchlist.replace(address, body?.tokens ?? []);
    return { tokens };
  }

  @Get()
  async get(@Param("address") address: string): Promise<{ tokens: ApiToken[] }> {
    const tokens = await this.watchlist.resolve(address);
    return { tokens };
  }
}
