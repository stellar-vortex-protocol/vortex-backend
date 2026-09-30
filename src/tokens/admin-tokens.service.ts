import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import { SupportedChain } from "../intents/intents.types";
import { CreateAdminTokenDto, DeleteAdminTokenDto, PatchAdminTokenDto } from "./dto/admin-token.dto";
import { ITokensRepository, TOKENS_REPOSITORY, TokenRecord, TokenStatus } from "./tokens.repository";
import { TokenVerifierService } from "./verification/token-verifier.service";
import { VerifiedTokenMetadata } from "./verification/evm-token.verifier";

/** WebSocket payload emitted after a successful registry mutation. */
export interface TokenListUpdatedEvent {
  type: "token_list_updated";
  action: "created" | "updated" | "delisted";
  chain: string;
  address: string;
  status: TokenStatus;
}

/**
 * Mutable publisher. IntentsModule points {@link publish} at the gateway
 * after both modules exist, avoiding an import cycle.
 */
export class TokenListPublisher {
  publish: (event: TokenListUpdatedEvent) => Promise<void> = async () => undefined;
}

/**
 * Admin registry writes. On-chain metadata is verified before any insert or
 * metadata update. A failed verification does not touch the repository.
 */
@Injectable()
export class AdminTokensService {
  constructor(
    @Inject(TOKENS_REPOSITORY) private readonly repo: ITokensRepository,
    private readonly verifier: TokenVerifierService,
    private readonly audit: AdminAuditService,
    private readonly publisher: TokenListPublisher,
  ) {}

  /** Register a token. Client decimals/symbol/name must match the chain when supplied. */
  async create(dto: CreateAdminTokenDto, admin: AdminPrincipal) {
    const chain = dto.chain as SupportedChain;
    const existing = this.repo.findByAddressAndChain(dto.address, chain);
    if (existing && (existing.status ?? "active") !== "delisted") {
      throw new ConflictException(`Token ${dto.address} on ${chain} is already registered`);
    }
    const verified = await this.verifyOrThrow(chain, dto.address);
    this.assertNoMismatch(dto, verified);
    const record = this.toRecord(chain, dto.address, verified, {
      name: dto.name,
      logoUri: dto.logoUri,
      priceUSD: dto.priceUSD,
      status: "active",
    });
    const saved = await this.repo.save(record);
    await this.audit.record({
      actor: admin.id,
      action: "token.create",
      target: this.target(chain, saved.address),
      after: saved,
    });
    await this.emit("created", saved);
    return this.toResponse(saved);
  }

  /**
   * Update status or display fields. Symbol and decimals are re-verified when
   * the caller sends them. Status-only changes (including delist) do not
   * require the RPC, so an operator can pause a token during an outage.
   */
  async update(dto: PatchAdminTokenDto, admin: AdminPrincipal) {
    const chain = dto.chain as SupportedChain;
    const existing = this.require(chain, dto.address);
    const metadataChange = dto.symbol !== undefined || dto.decimals !== undefined || dto.name !== undefined;
    let next: TokenRecord = { ...existing, status: dto.status ?? existing.status ?? "active" };
    if (metadataChange) {
      const verified = await this.verifyOrThrow(chain, dto.address);
      this.assertNoMismatch(dto, verified);
      next = {
        ...next,
        symbol: verified.symbol,
        decimals: verified.decimals,
        name: dto.name ?? verified.name ?? existing.name,
        assetKind: verified.assetKind,
      };
    }
    if (dto.logoUri !== undefined) next.logoUri = dto.logoUri;
    if (dto.priceUSD !== undefined) next.priceUsd = dto.priceUSD;
    const saved = await this.repo.save(next);
    await this.audit.record({
      actor: admin.id,
      action: "token.update",
      target: this.target(chain, saved.address),
      before: existing,
      after: saved,
    });
    await this.emit("updated", saved);
    return this.toResponse(saved);
  }

  /** Soft-delist. The row stays so intents that already reference the token keep working. */
  async delist(dto: DeleteAdminTokenDto, admin: AdminPrincipal) {
    const chain = dto.chain as SupportedChain;
    const existing = this.require(chain, dto.address);
    const saved = await this.repo.setStatus(dto.address, chain, "delisted");
    if (!saved) throw new NotFoundException(`Token ${dto.address} on ${chain} was not found`);
    await this.audit.record({
      actor: admin.id,
      action: "token.delist",
      target: this.target(chain, saved.address),
      before: existing,
      after: saved,
    });
    await this.emit("delisted", saved);
    return this.toResponse(saved);
  }

  private async verifyOrThrow(chain: SupportedChain, address: string) {
    try {
      const verified = await this.verifier.verify(chain, address);
      if (!verified.exists) {
        throw new BadRequestException({
          code: "TOKEN_NOT_FOUND",
          message: `No contract at ${address} on ${chain}`,
        });
      }
      return verified;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new ServiceUnavailableException(
        `Token verification failed and nothing was saved: ${(err as Error).message}`,
      );
    }
  }

  private assertNoMismatch(
    supplied: { symbol?: string; decimals?: number; name?: string },
    onChain: VerifiedTokenMetadata,
  ): void {
    const mismatches = this.verifier.mismatches(supplied, onChain);
    if (mismatches.length > 0) {
      throw new BadRequestException({
        code: "METADATA_MISMATCH",
        message: "Supplied token metadata does not match on-chain metadata",
        mismatches,
      });
    }
  }

  private require(chain: SupportedChain, address: string): TokenRecord {
    const existing = this.repo.findByAddressAndChain(address, chain);
    if (!existing) throw new NotFoundException(`Token ${address} on ${chain} was not found`);
    return existing;
  }

  private toRecord(
    chain: SupportedChain,
    address: string,
    verified: VerifiedTokenMetadata,
    extra: { name?: string; logoUri?: string; priceUSD?: number; status: TokenStatus },
  ): TokenRecord {
    return {
      address,
      chain,
      symbol: verified.symbol,
      name: extra.name ?? verified.name ?? verified.symbol,
      decimals: verified.decimals,
      logoUri: extra.logoUri ?? null,
      priceUsd: extra.priceUSD ?? null,
      isStellar: chain === "stellar",
      status: extra.status,
      assetKind: verified.assetKind,
    };
  }

  private toResponse(record: TokenRecord) {
    return {
      address: record.address,
      chain: record.chain,
      symbol: record.symbol,
      name: record.name,
      decimals: record.decimals,
      status: record.status ?? "active",
      assetKind: record.assetKind ?? (record.isStellar ? "stellar-sac" : "evm"),
      logoUri: record.logoUri ?? null,
      priceUSD: record.priceUsd ?? null,
    };
  }

  private target(chain: string, address: string): string {
    return `token:${chain}:${address}`;
  }

  private async emit(action: TokenListUpdatedEvent["action"], record: TokenRecord): Promise<void> {
    await this.publisher.publish({
      type: "token_list_updated",
      action,
      chain: record.chain,
      address: record.address,
      status: record.status ?? "active",
    });
  }
}
