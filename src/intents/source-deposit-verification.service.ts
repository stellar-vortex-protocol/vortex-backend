import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { DepositCheck, SOURCE_CHAIN_VERIFIERS, SourceChainVerifier } from "../chains/source-chain-verifier";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { isVersionConflict } from "./intents.repository";
import { Intent } from "./intents.types";

/** How often the verification queue is drained. */
export const SRC_VERIFY_TICK_MS = 15_000;
/** Verified-but-still-open intents are re-checked this often, to catch reorgs. */
export const SRC_REVERIFY_INTERVAL_MS = 60_000;
/** Retry backoff for unverified intents: 15 s doubling up to 10 min. */
export const SRC_RETRY_BASE_MS = 15_000;
export const SRC_RETRY_MAX_MS = 10 * 60_000;
/** Extra backoff multiplier after an RPC rate-limit response. */
export const SRC_RATE_LIMIT_MULTIPLIER = 4;
/** Deposits verified concurrently per tick — keeps RPC usage bounded. */
export const SRC_VERIFY_CONCURRENCY = 4;

interface ScheduleEntry {
  attempts: number;
  nextAt: number;
}

/**
 * Queues open intents for source-deposit verification and retries them
 * (issue #403).
 *
 * Every {@link SRC_VERIFY_TICK_MS} it scans open intents and verifies the
 * ones that are due:
 * - unverified intents, with exponential backoff between attempts (longer
 *   after an RPC rate limit);
 * - verified intents that are still open, every
 *   {@link SRC_REVERIFY_INTERVAL_MS}, so a reorg that removes the deposit or
 *   drops its block below the confirmation depth un-verifies the intent before
 *   a solver fills it.
 *
 * Results are written with optimistic concurrency (issue #405), and only
 * while the intent is still `open`. Transitions are broadcast as
 * `intent_src_verified` / `intent_src_unverified` on the WS feed. The queue is
 * rebuilt from the store every tick, so it survives restarts, and replicas
 * racing on the same intent are safe.
 *
 * Inert unless EVM_DEPOSIT_VERIFICATION_ENABLED=true.
 */
@Injectable()
export class SourceDepositVerificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SourceDepositVerificationService.name);
  private readonly schedule = new Map<string, ScheduleEntry>();
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly gateway: IntentsGateway,
    private readonly configService: ConfigService<AppConfig, true>,
    @Inject(SOURCE_CHAIN_VERIFIERS) private readonly verifiers: SourceChainVerifier[],
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  get enabled(): boolean {
    return this.configService.get("evm", { infer: true })?.depositVerificationEnabled === true;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.interval = setInterval(() => {
      this.tick().catch((err) =>
        this.logger.error(`[src-verify] tick failed: ${(err as Error).message}`),
      );
    }, SRC_VERIFY_TICK_MS);
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /**
   * Verify every due open intent once. Returns the number of intents checked.
   * Overlapping ticks are skipped rather than queued.
   */
  async tick(now = Date.now()): Promise<number> {
    if (!this.enabled || this.running) return 0;
    this.running = true;
    try {
      const open = await this.intentsService.getByState("open");
      const openIds = new Set(open.map((i) => i.intentId));
      for (const id of this.schedule.keys()) {
        if (!openIds.has(id)) this.schedule.delete(id);
      }

      const tracked = open.filter((i) => this.verifierFor(i) && this.needsCheck(i, now));
      this.metrics?.setSrcVerificationQueueSize(tracked.filter((i) => !i.srcVerified).length);
      const due = tracked.filter((i) => (this.schedule.get(i.intentId)?.nextAt ?? 0) <= now);

      for (let i = 0; i < due.length; i += SRC_VERIFY_CONCURRENCY) {
        await Promise.all(due.slice(i, i + SRC_VERIFY_CONCURRENCY).map((intent) => this.verifyOne(intent, now)));
      }
      return due.length;
    } finally {
      this.running = false;
    }
  }

  /** Verify one intent now and persist the outcome. */
  async verifyOne(intent: Intent, now = Date.now()): Promise<DepositCheck | undefined> {
    const verifier = this.verifierFor(intent);
    if (!verifier) return undefined;

    let check: DepositCheck;
    try {
      check = await verifier.verify(intent);
    } catch (err) {
      const rateLimited = isRateLimited(err);
      this.metrics?.recordSrcVerificationError(intent.srcChain, rateLimited ? "rate_limited" : "rpc_error");
      const delay = this.backoff(intent.intentId, now, rateLimited ? SRC_RATE_LIMIT_MULTIPLIER : 1);
      this.logger.warn(
        `[src-verify] ${intent.srcChain} RPC ${rateLimited ? "rate-limited" : "error"} for intent ${intent.intentId}; ` +
          `retrying in ${Math.round(delay / 1000)}s: ${(err as Error).message}`,
      );
      return undefined;
    }

    this.metrics?.recordSrcVerification(intent.srcChain, check.status);
    const verified = check.status === "verified";
    if (verified) {
      this.schedule.set(intent.intentId, { attempts: 0, nextAt: now + SRC_REVERIFY_INTERVAL_MS });
    } else {
      this.backoff(intent.intentId, now, 1);
    }

    const result = await this.intentsService.mutateWithRetry(intent.intentId, (current) =>
      current.state === "open"
        ? this.intentsService.update(
            current.intentId,
            {
              srcVerified: verified,
              srcVerification: {
                status: check.status,
                checkedAt: Math.floor(now / 1000),
                ...(check.blockNumber !== undefined ? { blockNumber: check.blockNumber.toString() } : {}),
                ...(check.blockHash ? { blockHash: check.blockHash } : {}),
                ...(check.receivedAmount ? { receivedAmount: check.receivedAmount } : {}),
                ...(check.detail ? { detail: check.detail } : {}),
              },
            },
            current.version,
          )
        : undefined,
    );
    if (!result || isVersionConflict(result)) return check;

    if (verified && !intent.srcVerified) {
      this.logger.log(`[src-verify] intent ${intent.intentId} deposit verified on ${intent.srcChain} (${check.detail ?? ""})`);
      await this.gateway.broadcast({ type: "intent_src_verified", intentId: intent.intentId, intent: result });
    } else if (!verified && intent.srcVerified) {
      this.logger.warn(
        `[src-verify] intent ${intent.intentId} UN-verified on ${intent.srcChain}: ${check.status} — ${check.detail ?? ""}`,
      );
      await this.gateway.broadcast({
        type: "intent_src_unverified",
        intentId: intent.intentId,
        srcChain: intent.srcChain,
        reason: check.status,
      });
    }
    return check;
  }

  private verifierFor(intent: Intent): SourceChainVerifier | undefined {
    return this.verifiers.find((v) => v.supports(intent.srcChain));
  }

  /**
   * Unverified intents always need a check. Verified ones need one only if
   * *this* verifier verified them (not `skipped`/`grandfathered`) and the
   * re-check interval has passed.
   */
  private needsCheck(intent: Intent, now: number): boolean {
    if (!intent.srcVerified) return true;
    const v = intent.srcVerification;
    return v?.status === "verified" && v.checkedAt * 1000 + SRC_REVERIFY_INTERVAL_MS <= now;
  }

  private backoff(intentId: string, now: number, multiplier: number): number {
    const attempts = (this.schedule.get(intentId)?.attempts ?? 0) + 1;
    const delay = Math.min(SRC_RETRY_BASE_MS * 2 ** (attempts - 1) * multiplier, SRC_RETRY_MAX_MS);
    this.schedule.set(intentId, { attempts, nextAt: now + delay });
    return delay;
  }
}

/** Walks an error's cause chain looking for an HTTP 429 or JSON-RPC limit error. */
export function isRateLimited(err: unknown): boolean {
  for (let e = err as { status?: number; code?: number; message?: string; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (e.status === 429 || e.code === -32005 || e.code === 429) return true;
    if (typeof e.message === "string" && /rate limit|too many requests|\b429\b/i.test(e.message)) return true;
  }
  return false;
}
