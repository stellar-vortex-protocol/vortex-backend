/**
 * AbuseScoreService — Redis-backed sliding-window scorer.
 *
 * Each rule evaluates a set of counters that are maintained in Redis using
 * sorted sets (ZRANGEBYSCORE / ZADD / ZREMRANGEBYSCORE) so the window slides
 * with wall-clock time rather than resetting on a fixed boundary.
 *
 * Design constraints
 * ──────────────────
 * - No ML: every rule is a named, configured threshold.
 * - Fail open: if Redis is unavailable the scorer returns a zero score so the
 *   request is not blocked due to an infrastructure outage.
 * - Non-blocking: all Redis calls are fire-and-read; the guard awaits the
 *   scoring result but not the counter writes (which use a background write).
 * - Allowlist wins: an API-key-allowlisted actor is scored (for transparency)
 *   but the action is always "pass".
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import {
  AbuseContext,
  AbuseRulesConfig,
  AbuseScore,
  AbuseSignal,
  AbuseAction,
  SignalFiring,
  DEFAULT_ABUSE_RULES,
  CHALLENGE_THRESHOLD,
  THROTTLE_THRESHOLD,
  BLOCK_THRESHOLD,
  AbuseAuditEvent,
} from "./abuse.types";
import { AppConfig } from "../config/configuration";

/** Redis key prefix for all abuse counters. */
const KEY_PREFIX = "vortex:abuse";

/** How many audit events to retain per actor in the Redis list (LPUSH + LTRIM). */
const AUDIT_LIST_MAX = 200;

/** TTL for audit lists (seconds) — keep 7 days of history. */
const AUDIT_TTL_SECONDS = 7 * 86_400;

/** TTL for score snapshots (seconds). */
const SCORE_TTL_SECONDS = 3 * 86_400;

@Injectable()
export class AbuseScoreService {
  private readonly logger = new Logger(AbuseScoreService.name);
  private readonly redis: Redis;
  private readonly rules: AbuseRulesConfig;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const url = config.get("redisUrl", { infer: true });
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    this.redis.on("error", (err: Error) =>
      this.logger.warn(`[abuse-scorer] Redis error — scoring will fail open: ${err.message}`),
    );

    // Rules live in config so operators can override them via env vars or
    // future runtime flag integration without touching code.
    this.rules = this.loadRulesFromConfig();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Evaluate all rules against `ctx` and return a composite score.
   * Counter increments are written to Redis asynchronously after the score is
   * returned — callers never wait on the write path.
   */
  async score(ctx: AbuseContext, allowlisted: boolean): Promise<AbuseScore> {
    const signals: SignalFiring[] = [];

    try {
      const now = Math.floor(Date.now() / 1000);
      const userKey = `user:${ctx.userAddress}`;
      const ipKey = `ip:${ctx.clientIp}`;

      // ── Rule: create/cancel ratio ─────────────────────────────────────────
      if (this.rules.create_cancel_ratio.enabled && ctx.operation === "create") {
        const fired = await this.evalCreateCancelRatio(ctx, now);
        if (fired) signals.push(fired);
      }

      // ── Rule: dust intent ─────────────────────────────────────────────────
      if (this.rules.dust_intent.enabled && ctx.operation === "create") {
        const fired = this.evalDustIntent(ctx);
        if (fired) signals.push(fired);
      }

      // ── Rule: burst of identical-parameter intents ────────────────────────
      if (this.rules.burst_identical.enabled && ctx.operation === "create") {
        const fired = await this.evalBurstIdentical(ctx, now);
        if (fired) signals.push(fired);
      }

      // ── Rule: new address ─────────────────────────────────────────────────
      if (this.rules.new_address.enabled && ctx.operation === "create") {
        const fired = this.evalNewAddress(ctx);
        if (fired) signals.push(fired);
      }

      // ── Rule: IP/ASN cluster ──────────────────────────────────────────────
      if (this.rules.ip_asn_cluster.enabled && ctx.operation === "create") {
        const fired = await this.evalIpAsnCluster(ctx, now);
        if (fired) signals.push(fired);
      }

      // ── Rule: solver spam ─────────────────────────────────────────────────
      if (this.rules.solver_spam.enabled && ctx.solverAddress && ctx.operation === "accept") {
        const fired = await this.evalSolverSpam(ctx, now);
        if (fired) signals.push(fired);
      }

      // ── Increment counters (async, non-blocking) ──────────────────────────
      void this.updateCounters(ctx, now, userKey, ipKey);

      const total = signals.reduce((sum, s) => sum + s.weight, 0);
      const action = allowlisted ? "pass" : this.actionFromScore(total);
      const result: AbuseScore = {
        total,
        action,
        signals,
        actors: [userKey, ipKey, ...(ctx.solverAddress ? [`solver:${ctx.solverAddress}`] : [])],
        allowlisted,
      };

      // Persist score snapshot + audit log (async)
      void this.persistAudit(ctx, result);

      return result;
    } catch (err) {
      // Fail open — a Redis outage must not block legitimate traffic.
      this.logger.warn(`[abuse-scorer] Scoring error, failing open: ${(err as Error).message}`);
      return {
        total: 0,
        action: "pass",
        signals: [],
        actors: [],
        allowlisted,
      };
    }
  }

  /**
   * Record a cancellation event for a user (increments cancel counter).
   * Called from the controller after a cancel is accepted.
   */
  async recordCancel(userAddress: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const key = `${KEY_PREFIX}:user:${userAddress}:cancels`;
    const windowSeconds = this.rules.create_cancel_ratio.windowSeconds;
    try {
      const pipeline = this.redis.pipeline();
      pipeline.zadd(key, now, `${now}:${Math.random()}`);
      pipeline.zremrangebyscore(key, "-inf", now - windowSeconds);
      pipeline.expire(key, windowSeconds * 2);
      await pipeline.exec();
    } catch (err) {
      this.logger.debug(`[abuse-scorer] recordCancel failed (non-critical): ${(err as Error).message}`);
    }
  }

  /**
   * Return recent audit events for a user address (admin/transparency endpoint).
   */
  async getAuditHistory(userAddress: string, limit = 20): Promise<AbuseAuditEvent[]> {
    try {
      const raw = await this.redis.lrange(
        `${KEY_PREFIX}:audit:user:${userAddress}`,
        0,
        limit - 1,
      );
      return raw.map((r) => JSON.parse(r) as AbuseAuditEvent);
    } catch {
      return [];
    }
  }

  /**
   * Return the latest cached score for a user (used by stats transparency endpoint).
   */
  async getCachedScore(userAddress: string): Promise<number | null> {
    try {
      const raw = await this.redis.get(`${KEY_PREFIX}:score:user:${userAddress}`);
      return raw !== null ? Number(raw) : null;
    } catch {
      return null;
    }
  }

  // ── Rule evaluators ─────────────────────────────────────────────────────────

  private async evalCreateCancelRatio(
    ctx: AbuseContext,
    now: number,
  ): Promise<SignalFiring | null> {
    const rule = this.rules.create_cancel_ratio;
    const createKey = `${KEY_PREFIX}:user:${ctx.userAddress}:creates`;
    const cancelKey = `${KEY_PREFIX}:user:${ctx.userAddress}:cancels`;
    const since = now - rule.windowSeconds;

    const [createCount, cancelCount] = await Promise.all([
      this.redis.zcount(createKey, since, "+inf"),
      this.redis.zcount(cancelKey, since, "+inf"),
    ]);

    if (createCount < rule.minCreates) return null;
    const ratio = createCount > 0 ? cancelCount / createCount : 0;
    if (ratio < rule.minCancelRatio) return null;

    return {
      signal: "create_cancel_ratio",
      weight: rule.weight,
      detail: `cancel/create ratio ${ratio.toFixed(2)} (${cancelCount}/${createCount}) over ${rule.windowSeconds}s window`,
    };
  }

  private evalDustIntent(ctx: AbuseContext): SignalFiring | null {
    const rule = this.rules.dust_intent;
    const price = ctx.srcTokenPriceUsd ?? 0;
    const decimals = ctx.srcTokenDecimals ?? 6;
    if (price <= 0) return null; // can't evaluate without price

    const humanAmount = Number(BigInt(ctx.srcAmount)) / Math.pow(10, decimals);
    const usdValue = humanAmount * price;

    if (usdValue >= rule.maxDustUsd) return null;

    return {
      signal: "dust_intent",
      weight: rule.weight,
      detail: `intent value $${usdValue.toFixed(6)} below dust threshold $${rule.maxDustUsd}`,
    };
  }

  private async evalBurstIdentical(
    ctx: AbuseContext,
    now: number,
  ): Promise<SignalFiring | null> {
    const rule = this.rules.burst_identical;
    const key = `${KEY_PREFIX}:user:${ctx.userAddress}:fp:${ctx.intentFingerprint}`;
    const since = now - rule.windowSeconds;

    const count = await this.redis.zcount(key, since, "+inf");
    if (count < rule.maxCount) return null;

    return {
      signal: "burst_identical",
      weight: rule.weight,
      detail: `${count} identical-parameter intents in ${rule.windowSeconds}s`,
    };
  }

  private evalNewAddress(ctx: AbuseContext): SignalFiring | null {
    const rule = this.rules.new_address;
    if (ctx.accountAgeSeconds === undefined) return null; // Horizon not consulted yet
    if (ctx.accountAgeSeconds >= rule.minAgeSeconds) return null;

    return {
      signal: "new_address",
      weight: rule.weight,
      detail: `account age ${ctx.accountAgeSeconds}s < minimum ${rule.minAgeSeconds}s`,
    };
  }

  private async evalIpAsnCluster(
    ctx: AbuseContext,
    now: number,
  ): Promise<SignalFiring | null> {
    const rule = this.rules.ip_asn_cluster;
    const key = `${KEY_PREFIX}:ip:${ctx.clientIp}:users`;
    const since = now - rule.windowSeconds;

    // Each entry is "<timestamp>:<userAddress>" — we count distinct users via
    // a separate HyperLogLog for accuracy at scale, but for the sliding window
    // we use a sorted-set of "<ts>:<user>" entries and count them.
    const members = await this.redis.zrangebyscore(key, since, "+inf");
    const uniqueUsers = new Set(members.map((m) => m.split(":").slice(1).join(":"))).size;

    if (uniqueUsers < rule.minAddressesPerIp) return null;

    return {
      signal: "ip_asn_cluster",
      weight: rule.weight,
      detail: `IP ${ctx.clientIp} associated with ${uniqueUsers} distinct addresses in ${rule.windowSeconds}s`,
    };
  }

  private async evalSolverSpam(
    ctx: AbuseContext,
    now: number,
  ): Promise<SignalFiring | null> {
    if (!ctx.solverAddress) return null;
    const rule = this.rules.solver_spam;
    const key = `${KEY_PREFIX}:solver:${ctx.solverAddress}:cycles`;
    const since = now - rule.windowSeconds;

    const count = await this.redis.zcount(key, since, "+inf");
    if (count < rule.maxCycles) return null;

    return {
      signal: "solver_spam",
      weight: rule.weight,
      detail: `solver ${ctx.solverAddress} performed ${count} accept/cancel cycles in ${rule.windowSeconds}s`,
    };
  }

  // ── Counter writes (async, non-blocking) ───────────────────────────────────

  private async updateCounters(
    ctx: AbuseContext,
    now: number,
    userKey: string,
    ipKey: string,
  ): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      const jitter = `${now}:${Math.random().toString(36).slice(2, 8)}`;

      if (ctx.operation === "create") {
        const createKey = `${KEY_PREFIX}:${userKey}:creates`;
        const createWindow = this.rules.create_cancel_ratio.windowSeconds;
        pipeline.zadd(createKey, now, jitter);
        pipeline.zremrangebyscore(createKey, "-inf", now - createWindow);
        pipeline.expire(createKey, createWindow * 2);

        // Burst fingerprint counter
        const fpKey = `${KEY_PREFIX}:${userKey}:fp:${ctx.intentFingerprint}`;
        const burstWindow = this.rules.burst_identical.windowSeconds;
        pipeline.zadd(fpKey, now, jitter);
        pipeline.zremrangebyscore(fpKey, "-inf", now - burstWindow);
        pipeline.expire(fpKey, burstWindow * 2);

        // IP → users cluster counter
        const clusterKey = `${KEY_PREFIX}:${ipKey}:users`;
        const clusterWindow = this.rules.ip_asn_cluster.windowSeconds;
        pipeline.zadd(clusterKey, now, `${now}:${ctx.userAddress}`);
        pipeline.zremrangebyscore(clusterKey, "-inf", now - clusterWindow);
        pipeline.expire(clusterKey, clusterWindow * 2);
      }

      if (ctx.operation === "accept" && ctx.solverAddress) {
        const cycleKey = `${KEY_PREFIX}:solver:${ctx.solverAddress}:cycles`;
        const cycleWindow = this.rules.solver_spam.windowSeconds;
        pipeline.zadd(cycleKey, now, jitter);
        pipeline.zremrangebyscore(cycleKey, "-inf", now - cycleWindow);
        pipeline.expire(cycleKey, cycleWindow * 2);
      }

      await pipeline.exec();
    } catch (err) {
      this.logger.debug(`[abuse-scorer] counter update failed (non-critical): ${(err as Error).message}`);
    }
  }

  // ── Audit persistence ───────────────────────────────────────────────────────

  private async persistAudit(ctx: AbuseContext, result: AbuseScore): Promise<void> {
    try {
      const event: AbuseAuditEvent = {
        timestamp: new Date().toISOString(),
        userAddress: ctx.userAddress,
        clientIp: ctx.clientIp,
        operation: ctx.operation,
        score: result.total,
        action: result.action,
        signals: result.signals,
        allowlisted: result.allowlisted,
      };
      const raw = JSON.stringify(event);
      const auditKey = `${KEY_PREFIX}:audit:user:${ctx.userAddress}`;
      const scoreKey = `${KEY_PREFIX}:score:user:${ctx.userAddress}`;

      const pipeline = this.redis.pipeline();
      pipeline.lpush(auditKey, raw);
      pipeline.ltrim(auditKey, 0, AUDIT_LIST_MAX - 1);
      pipeline.expire(auditKey, AUDIT_TTL_SECONDS);
      pipeline.set(scoreKey, String(result.total), "EX", SCORE_TTL_SECONDS);
      await pipeline.exec();
    } catch (err) {
      this.logger.debug(`[abuse-scorer] audit persist failed (non-critical): ${(err as Error).message}`);
    }
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  private actionFromScore(score: number): AbuseAction {
    if (score >= BLOCK_THRESHOLD) return "block";
    if (score >= THROTTLE_THRESHOLD) return "throttle";
    if (score >= CHALLENGE_THRESHOLD) return "challenge";
    return "pass";
  }

  /**
   * Load rule configuration from env vars with fallback to DEFAULT_ABUSE_RULES.
   *
   * Each rule can be overridden by a prefixed env var:
   *   ABUSE_<RULE>_WEIGHT, ABUSE_<RULE>_WINDOW, ABUSE_<RULE>_ENABLED
   * e.g. ABUSE_DUST_INTENT_WEIGHT=30, ABUSE_CREATE_CANCEL_RATIO_ENABLED=false
   */
  private loadRulesFromConfig(): AbuseRulesConfig {
    const rules = structuredClone(DEFAULT_ABUSE_RULES);

    const overrideNum = (envKey: string, fallback: number): number => {
      const raw = process.env[envKey];
      if (raw === undefined) return fallback;
      const v = Number(raw);
      return Number.isFinite(v) ? v : fallback;
    };
    const overrideBool = (envKey: string, fallback: boolean): boolean => {
      const raw = process.env[envKey];
      if (raw === undefined) return fallback;
      return raw === "true";
    };

    for (const signal of Object.keys(rules) as AbuseSignal[]) {
      const prefix = `ABUSE_${signal.toUpperCase().replace(/-/g, "_")}`;
      const rule = rules[signal] as AbuseRulesConfig[typeof signal];
      rule.enabled = overrideBool(`${prefix}_ENABLED`, rule.enabled);
      rule.weight = overrideNum(`${prefix}_WEIGHT`, rule.weight);
      rule.windowSeconds = overrideNum(`${prefix}_WINDOW`, rule.windowSeconds);
    }

    rules.create_cancel_ratio.minCancelRatio = overrideNum(
      "ABUSE_CREATE_CANCEL_RATIO_MIN_RATIO",
      rules.create_cancel_ratio.minCancelRatio,
    );
    rules.create_cancel_ratio.minCreates = overrideNum(
      "ABUSE_CREATE_CANCEL_RATIO_MIN_CREATES",
      rules.create_cancel_ratio.minCreates,
    );
    rules.dust_intent.maxDustUsd = overrideNum(
      "ABUSE_DUST_INTENT_MAX_USD",
      rules.dust_intent.maxDustUsd,
    );
    rules.burst_identical.maxCount = overrideNum(
      "ABUSE_BURST_IDENTICAL_MAX_COUNT",
      rules.burst_identical.maxCount,
    );
    rules.new_address.minAgeSeconds = overrideNum(
      "ABUSE_NEW_ADDRESS_MIN_AGE_SECONDS",
      rules.new_address.minAgeSeconds,
    );
    rules.ip_asn_cluster.minAddressesPerIp = overrideNum(
      "ABUSE_IP_ASN_CLUSTER_MIN_ADDRESSES",
      rules.ip_asn_cluster.minAddressesPerIp,
    );
    rules.solver_spam.maxCycles = overrideNum(
      "ABUSE_SOLVER_SPAM_MAX_CYCLES",
      rules.solver_spam.maxCycles,
    );

    return rules;
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
