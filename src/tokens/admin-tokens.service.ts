import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import { SupportedChain } from "../intents/intents.types";
import { CreateAdminTokenDto, DeleteAdminTokenDto, PatchAdminTokenDto } from "./dto/admin-token.dto";
import { ITokensRepository, TOKENS_REPOSITORY, TokenRecord, TokenStatus } from "./tokens.repository";
import { TokenVerifierService } from "./verification/token-verifier.service";
import { VerifiedTokenMetadata } from "./verification/evm-token.verifier";
import { HttpEgressService } from "../common/http-egress/http-egress.service";

/** WebSocket payload emitted after a successful registry mutation. */
export interface TokenListUpdatedEvent {
  type: "token_list_updated";
  action: "created" | "updated" | "delisted";
  chain: string;
  address: string;
  status: TokenStatus;
}

/** A persisted registry mutation, exposed by the public changelog (issue #654). */
export interface TokenChangelogEntry extends TokenListUpdatedEvent {
  /** Monotonic sequence number; usable as a `since` cursor. */
  seq: number;
  /** ISO-8601 timestamp of when the mutation was recorded. */
  timestamp: string;
}

/** Maximum number of changelog entries retained in memory (issue #654). */
export const MAX_CHANGELOG_ENTRIES = 200;

/**
 * Mutable publisher. IntentsModule points {@link publish} at the gateway
 * after both modules exist, avoiding an import cycle.
 */
export class TokenListPublisher {
  publish: (event: TokenListUpdatedEvent) => Promise<void> = async () => undefined;
}

/** Content-types accepted for admin-supplied token logos (issue #652). */
export const ALLOWED_LOGO_CONTENT_TYPES = ["image/png", "image/svg+xml", "image/webp"] as const;

/** Upper bound on a verified logo body, in bytes (issue #652). */
export const MAX_LOGO_BYTES = 256 * 1024;

/** How long a verified logo stays cached, in milliseconds (issue #652). */
export const LOGO_CACHE_TTL_MS = 60 * 60 * 1000;

/** Maximum number of tokens accepted in a single batch create call (issue #653). */
export const MAX_BATCH_CREATE_TOKENS = 50;

/** Per-item outcome of a batch create call (issue #653). */
export interface BatchCreateTokenResult {
  index: number;
  address: string;
  chain: string;
  success: boolean;
  token?: ReturnType<AdminTokensService["toResponse"]>;
  error?: { code: string; message: string };
}

/** A verified logo body plus the content-type it was served with. */
export interface CachedLogo {
  contentType: string;
  body: Buffer;
  expiresAt: number;
}

/**
 * Admin registry writes. On-chain metadata is verified before any insert or
 * metadata update. A failed verification does not touch the repository.
 */
@Injectable()
export class AdminTokensService {
  /** In-memory verified-logo cache keyed by `(chain, address)` (issue #652). */
  private readonly logoCache = new Map<string, CachedLogo>();

  /**
   * Bounded ring of recent registry mutations (issue #654). Appended from the
   * same {@link emit} hook that publishes the live WebSocket event, so there is
   * no second mutation path.
   */
  private readonly changelog: TokenChangelogEntry[] = [];
  private changelogSeq = 0;

  constructor(
    @Inject(TOKENS_REPOSITORY) private readonly repo: ITokensRepository,
    private readonly verifier: TokenVerifierService,
    private readonly audit: AdminAuditService,
    private readonly publisher: TokenListPublisher,
    /** Read cache (issue #414): every registry write drops the cached token lists. */
    @Optional() private readonly cache?: CacheService,
    /** Egress client used to verify and fetch admin-supplied logos (issue #652). */
    @Optional() private readonly egress?: HttpEgressService,
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
    if (dto.logoUri !== undefined) await this.verifyLogoOrThrow(dto.logoUri);
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
   * Register several tokens in one call (issue #653). Each entry runs through
   * the exact same {@link create} path (verification, mismatch checks, audit,
   * publish) sequentially so a single bad entry never fails the whole batch
   * and the chain RPC/EVM reader is not hammered with concurrent calls.
   */
  async createBatch(
    dtos: CreateAdminTokenDto[],
    admin: AdminPrincipal,
  ): Promise<BatchCreateTokenResult[]> {
    if (dtos.length > MAX_BATCH_CREATE_TOKENS) {
      throw new BadRequestException({
        code: "BATCH_TOO_LARGE",
        message: `At most ${MAX_BATCH_CREATE_TOKENS} tokens may be created per batch`,
      });
    }
    const results: BatchCreateTokenResult[] = [];
    for (let index = 0; index < dtos.length; index += 1) {
      const dto = dtos[index];
      try {
        const token = await this.create(dto, admin);
        results.push({ index, address: dto.address, chain: dto.chain, success: true, token });
      } catch (err) {
        results.push({
          index,
          address: dto.address,
          chain: dto.chain,
          success: false,
          error: this.toBatchError(err),
        });
      }
    }
    return results;
  }

  /** Normalise a thrown error into a stable `{ code, message }` batch result. */
  private toBatchError(err: unknown): { code: string; message: string } {
    if (err instanceof BadRequestException) {
      const response = err.getResponse();
      if (typeof response === "object" && response !== null && "code" in response) {
        const { code, message } = response as { code: string; message?: string };
        return { code, message: message ?? err.message };
      }
      return { code: "BAD_REQUEST", message: err.message };
    }
    if (err instanceof ConflictException) return { code: "CONFLICT", message: err.message };
    if (err instanceof NotFoundException) return { code: "NOT_FOUND", message: err.message };
    if (err instanceof ServiceUnavailableException) {
      return { code: "VERIFICATION_UNAVAILABLE", message: err.message };
    }
    return { code: "INTERNAL_ERROR", message: (err as Error)?.message ?? "Unknown error" };
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
    if (dto.logoUri !== undefined) {
      await this.verifyLogoOrThrow(dto.logoUri);
      next.logoUri = dto.logoUri;
    }
    if (dto.priceUSD !== undefined) next.priceUsd = dto.priceUSD;
    const saved = await this.repo.save(next);
    // A changed logo invalidates any previously cached bytes for this token.
    if (dto.logoUri !== undefined) this.logoCache.delete(this.logoKey(chain, saved.address));
    await this.audit.record({
      actor: admin.id,
      action: "token.update",
      target: this.target(chain, saved.address),
      before: existing,
      after: saved,
    });
    await this.emit(saved.status === "delisted" ? "delisted" : "updated", saved);
    return this.toResponse(saved);
  }

  /**
   * Return recent registry mutations after an optional cursor (issue #654).
   * `since` may be a numeric sequence number or an ISO-8601 timestamp; entries
   * strictly after the cursor are returned in ascending order.
   */
  getChangelog(since?: string): TokenChangelogEntry[] {
    if (!since) return [...this.changelog];
    const asSeq = Number(since);
    if (Number.isFinite(asSeq)) {
      return this.changelog.filter((entry) => entry.seq > asSeq);
    }
    const asTime = Date.parse(since);
    if (Number.isNaN(asTime)) {
      throw new BadRequestException({
        code: "INVALID_CURSOR",
        message: "`since` must be a sequence number or an ISO-8601 timestamp",
      });
    }
    return this.changelog.filter((entry) => Date.parse(entry.timestamp) > asTime);
  }

  /** Current cache generation, used as the changelog `ETag` (issue #654). */
  cacheGeneration(): number {
    return this.repo.cacheGeneration();
  }

  /** Append a mutation to the bounded changelog ring (issue #654). */
  private recordChangelog(event: TokenListUpdatedEvent): void {
    this.changelogSeq += 1;
    this.changelog.push({
      ...event,
      seq: this.changelogSeq,
      timestamp: new Date().toISOString(),
    });
    if (this.changelog.length > MAX_CHANGELOG_ENTRIES) {
      this.changelog.splice(0, this.changelog.length - MAX_CHANGELOG_ENTRIES);
    }
  }

  /* … remaining helpers (emit, verify, etc.) unchanged … */
}
