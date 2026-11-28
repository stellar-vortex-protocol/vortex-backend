import { Injectable } from '@nestjs/common';
import { ITokensRepository } from './tokens.repository';
import { TokenRecord } from './tokens.types';
import { SUPPORTED_TOKENS } from './tokens.data';

@Injectable()
export class InMemoryTokensRepository implements ITokensRepository {
  private readonly tokens: TokenRecord[] = SUPPORTED_TOKENS.map((token) => ({
    ...token,
  }));

  async findAll(): Promise<TokenRecord[]> {
    return this.tokens.map((token) => ({ ...token }));
  }

  async findByChain(chain: string): Promise<TokenRecord[]> {
    return this.tokens
      .filter((token) => token.chain === chain)
      .map((token) => ({ ...token }));
  }

  async search(query: string, chain?: string): Promise<TokenRecord[]> {
    const needle = query.trim().toLowerCase();
    const source = chain ? await this.findByChain(chain) : await this.findAll();

    if (!needle) {
      return source;
    }

    return source.filter((token) => {
      const symbol = token.symbol?.toLowerCase() ?? '';
      const name = token.name?.toLowerCase() ?? '';
      return symbol.includes(needle) || name.includes(needle);
    });
  }
}
