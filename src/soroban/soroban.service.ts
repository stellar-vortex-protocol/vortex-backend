/**
 * Soroban RPC client facade.
 *
 * When SOROBAN_RPC_URLS is set (comma-separated), requests are routed through
 * the multi-endpoint RpcPool (circuit breaker, health scoring, failover).
 * When only SOROBAN_RPC_URL is set the service falls back to a single
 * SorobanRpc.Server — fully backward compatible.
 *
 * The pool is initialised lazily on the first request to avoid blocking the
 * NestJS bootstrap sequence on network I/O. Callers see no difference.
 *
 * @module soroban/soroban.service
 */

import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Networks, SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/configuration";
import { RpcPool, parseRpcUrls, type EndpointHealth } from "./rpc-pool";

const NETWORK_PASSPHRASE: Record<AppConfig["stellar"]["network"], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

@Injectable()
export class SorobanService implements OnModuleDestroy {
  private readonly logger = new Logger(SorobanService.name);

  /** Single-endpoint fallback (always present). */
  private readonly singleServer: SorobanRpc.Server;

  /** Multi-endpoint pool (null until initialised or when only one URL is configured). */
  private pool: RpcPool | null = null;
  private poolInitPromise: Promise<void> | null = null;

  private readonly usePool: boolean;
  private readonly expectedPassphrase: string;
  private readonly rpcUrlsRaw: string;
  private readonly rpcUrlSingle: string;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    this.rpcUrlSingle = configService.get("stellar.sorobanRpcUrl", { infer: true });
    this.rpcUrlsRaw = configService.get("stellar.sorobanRpcUrls", { infer: true });
    const network = configService.get("stellar.network", { infer: true });
    this.expectedPassphrase = NETWORK_PASSPHRASE[network];

    this.singleServer = new SorobanRpc.Server(this.rpcUrlSingle, {
      allowHttp: this.rpcUrlSingle.startsWith("http://"),
    });

    const endpoints = parseRpcUrls(this.rpcUrlsRaw, this.rpcUrlSingle);
    this.usePool = endpoints.length > 1;

    if (this.usePool) {
      this.logger.log(
        `[soroban] multi-endpoint pool enabled with ${endpoints.length} endpoints`,
      );
      // Kick off pool initialisation in the background — don't await here so
      // module bootstrap is not blocked on network I/O.
      this.poolInitPromise = RpcPool.create({
        endpoints,
        expectedNetwork: this.expectedPassphrase,
        logger: this.logger,
      })
        .then((p) => {
          this.pool = p;
          this.logger.log("[soroban] RpcPool ready");
        })
        .catch((err) => {
          this.logger.error(
            `[soroban] RpcPool init failed, falling back to single endpoint: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          this.poolInitPromise = null;
        });
    }
  }

  onModuleDestroy(): void {
    this.pool?.destroy();
  }

  // ── Pool or single-server selector ────────────────────────────────────────

  private get server(): SorobanRpc.Server | RpcPool {
    return this.pool ?? this.singleServer;
  }

  // ── Public API (mirrors original SorobanRpc.Server surface) ──────────────

  getHealth() {
    return this.server.getHealth();
  }

  getLatestLedger() {
    return this.server.getLatestLedger();
  }

  getNetwork() {
    return this.server.getNetwork();
  }

  getAccount(publicKey: string) {
    return this.server.getAccount(publicKey);
  }

  getEvents(request: SorobanRpc.Server.GetEventsRequest) {
    return this.server.getEvents(request);
  }

  getFeeStats(): Promise<SorobanRpc.Api.GetFeeStatsResponse> {
    return this.server.getFeeStats();
  }

  simulateTransaction(
    transaction: Transaction,
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return this.server.simulateTransaction(transaction);
  }

  prepareTransaction(
    transaction: Transaction,
  ): Promise<Transaction> {
    return this.server.prepareTransaction(transaction) as Promise<Transaction>;
  }

  /**
   * Submit a transaction to the network.
   *
   * When the pool is active, the call is pinned to a single endpoint so that
   * subsequent `getTransaction` status lookups hit the same node and don't
   * race event propagation. Returns `{ response, pinnedUrl }` when the pool
   * is used, or plain `response` when falling back to the single server.
   */
  async submitTransaction(
    transaction: Transaction,
  ): Promise<SorobanRpc.Api.SendTransactionResponse> {
    if (this.pool) {
      const { response } = await this.pool.sendTransaction(transaction);
      return response;
    }
    return this.singleServer.sendTransaction(transaction);
  }

  // ── Pool-specific health reporting (#393) ─────────────────────────────────

  /**
   * Per-endpoint health status. Returns a single synthetic entry when the pool
   * is not in use (single-endpoint mode).
   */
  getEndpointHealthReport(): EndpointHealth[] {
    if (this.pool) {
      return this.pool.getEndpointHealth();
    }
    // Single-endpoint mode: return a best-effort synthetic entry.
    return [
      {
        url: this.rpcUrlSingle,
        state: "closed",
        score: 1,
        errorRate: 0,
        p95LatencyMs: 0,
        ledgerLag: 0,
        lastSuccessAt: null,
        lastErrorAt: null,
        consecutiveErrors: 0,
      },
    ];
  }
}
