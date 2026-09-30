import { BadRequestException, Injectable } from "@nestjs/common";
import { SUPPORTED_CHAINS, SupportedChain } from "../../intents/intents.types";
import { EvmTokenVerifier, VerifiedTokenMetadata } from "./evm-token.verifier";
import { StellarTokenVerifier } from "./stellar-token.verifier";

export interface MetadataMismatch {
  field: "symbol" | "decimals" | "name";
  supplied: string | number;
  onChain: string | number | null;
}

/**
 * Dispatches token verification to the EVM or Stellar chain-family
 * implementation and rejects client metadata that disagrees with the chain.
 */
@Injectable()
export class TokenVerifierService {
  constructor(
    private readonly evm: EvmTokenVerifier,
    private readonly stellar: StellarTokenVerifier,
  ) {}

  /**
   * Read authoritative metadata. Throws when the chain family cannot verify
   * the address. `exists: false` means the contract is not deployed.
   */
  async verify(chain: SupportedChain, address: string): Promise<VerifiedTokenMetadata> {
    if (!(SUPPORTED_CHAINS as readonly string[]).includes(chain)) {
      throw new BadRequestException(`Unsupported chain '${chain}'`);
    }
    if (chain === "stellar") return this.stellar.verify(address);
    return this.evm.verify(chain, address);
  }

  /**
   * Compare optional client fields with the chain. Empty client fields are
   * not a mismatch — the on-chain value is used. Any supplied conflict is.
   */
  mismatches(
    supplied: { symbol?: string; decimals?: number; name?: string },
    onChain: VerifiedTokenMetadata,
  ): MetadataMismatch[] {
    const found: MetadataMismatch[] = [];
    if (supplied.symbol !== undefined && supplied.symbol !== onChain.symbol) {
      found.push({ field: "symbol", supplied: supplied.symbol, onChain: onChain.symbol });
    }
    if (supplied.decimals !== undefined && supplied.decimals !== onChain.decimals) {
      found.push({ field: "decimals", supplied: supplied.decimals, onChain: onChain.decimals });
    }
    if (supplied.name !== undefined && onChain.name !== null && supplied.name !== onChain.name) {
      found.push({ field: "name", supplied: supplied.name, onChain: onChain.name });
    }
    return found;
  }
}
