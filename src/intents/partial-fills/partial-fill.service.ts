import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig, CHAIN_FILL_WINDOW_DEFAULTS, DEFAULT_FILL_WINDOW_SECONDS } from "../../config/configuration";
import { createLogger } from "../../common/logger";
import { IntentsService } from "../intents.service";
import { IntentsGateway } from "../intents.gateway";
import { FillProgress, Intent, IntentFill } from "../intents.types";
import { SolversService } from "../../solvers/solvers.service";
import { SolverGriefingService } from "../../solvers/solver-griefing.service";
import { SolverRegistryService } from "../../soroban/solver-registry.service";
import { allocation, computeFillProgress } from "./partial-fill.math";
import { IIntentFillsRepository, INTENT_FILLS_REPOSITORY } from "./intent-fills.repository";

/** Protocol fee on a delivered amount — 5 bps, matching the all-or-nothing fill path. */
function protocolFee(dstAmount: bigint): bigint {
  return (dstAmount * 5n) / 10_000n;
}

/** An intent with its fills and progress attached. */
export interface IntentWithFills {
  intent: Intent;
  fills: IntentFill[];
  fillProgress: FillProgress;
}

/**
 * Partial fills for large intents (issue #427).
 *
 * An intent created with `allowPartialFill: true` stays `open` while solvers
 * reserve and fill tranches of its `srcAmount`:
 *
 * ```
 *  reserve(amount) ──► tranche "reserved" ──fill(dst ≥ pro-rata min)──► "filled"
 *                              │
 *                              └─ deadline passes ──► "slashed" (that solver,
 *                                                     that tranche only; the
 *                                                     amount returns to the pool)
 * ```
 *
 * Accounting invariant, enforced under a per-intent lock by the repository:
 * `filled + reserved + remaining = srcAmount`, so Σ fills ≤ srcAmount.
 *
 * When the last tranche fills (nothing reserved, nothing remaining) the intent
 * settles to `filled` through the existing guarded edges (see
 * {@link IntentsService.settlePartialFill}). A user may cancel the remainder of
 * a partially filled intent — it then settles to `filled` with
 * `fillProgress.remainderCancelled` — but not while reservations are live,
 * since a solver may be mid-delivery. If the intent deadline passes with fills
 * but an unfilled remainder, it expires as usual and `fillProgress` keeps the
 * record of what was delivered.
 *
 * `IntentState` is unchanged: `partially_filled` is visible as
 * `fillProgress.status`, never as `state`.
 */
@Injectable()
export class PartialFillService {
  private readonly log = createLogger(PartialFillService.name);
  private readonly onchainEnabled: boolean;

  constructor(
    private readonly intents: IntentsService,
    @Inject(INTENT_FILLS_REPOSITORY) private readonly fills: IIntentFillsRepository,
    private readonly gateway: IntentsGateway,
    private readonly solvers: SolversService,
    config: ConfigService<AppConfig, true>,
    @Optional() private readonly solverRegistry?: SolverRegistryService,
    @Optional() private readonly griefing?: SolverGriefingService,
  ) {
    this.onchainEnabled = config.get("partialFills", { infer: true })?.onchainEnabled ?? false;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Attach `fillProgress` to partial-fill intents; others pass through untouched. */
  async withProgress(intent: Intent): Promise<Intent>;
  async withProgress(intents: Intent[]): Promise<Intent[]>;
  async withProgress(input: Intent | Intent[]): Promise<Intent | Intent[]> {
    const list = Array.isArray(input) ? input : [input];
    const decorated = await Promise.all(
      list.map(async (intent) => {
        if (!intent.allowPartialFill) return intent;
        const fills = await this.fills.listByIntent(intent.intentId);
        return { ...intent, fillProgress: computeFillProgress(intent, fills) };
      }),
    );
    return Array.isArray(input) ? decorated : decorated[0];
  }

  async details(intent: Intent): Promise<IntentWithFills> {
    const fills = await this.fills.listByIntent(intent.intentId);
    const fillProgress = computeFillProgress(intent, fills);
    return { intent: { ...intent, fillProgress }, fills, fillProgress };
  }

  // ── reserve ──────────────────────────────────────────────────────────────

  /**
   * Reserve `amount` of `intent.srcAmount` for `solver`. Solver eligibility
   * (registered, bonded, not suspended, signature) is the caller's job.
   *
   * The tranche deadline is `now + fill window`, capped at the intent's own
   * deadline, so every tranche resolves — filled or slashed — before the
   * intent can expire around it.
   */
  async reserve(intent: Intent, solver: string, amount: string, now: number): Promise<{ fill: IntentFill; intent: Intent }> {
    if (!intent.allowPartialFill) {
      throw new ConflictException("Intent does not allow partial fills — accept it via POST /intents/:id/accept");
    }
    if (intent.state !== "open") throw new ConflictException(`Intent is ${intent.state}, cannot reserve`);
    if (intent.deadline <= now) throw new GoneException("Intent has expired");
    if (intent.srcVerified === false) {
      throw new ConflictException("Source deposit is not verified yet; the intent cannot be reserved");
    }

    const window = CHAIN_FILL_WINDOW_DEFAULTS[intent.srcChain] ?? DEFAULT_FILL_WINDOW_SECONDS;
    const deadline = Math.min(now + window, intent.deadline);
    const result = await this.fills.reserve(
      {
        intentId: intent.intentId,
        srcAmount: intent.srcAmount,
        minDstAmount: intent.minDstAmount,
        minFillAmount: intent.minFillAmount,
        solver,
        amount,
        deadline,
        now,
      },
      async () => {
        const current = await this.intents.get(intent.intentId);
        return !!current && current.state === "open" && current.deadline > now;
      },
    );

    if (!result.ok) {
      const detail = { intentId: intent.intentId, requested: amount, remainingAmount: result.remaining };
      switch (result.reason) {
        case "invalid_amount":
          throw new BadRequestException({ error: "amount must be a positive integer string", ...detail });
        case "below_min_fill":
          throw new BadRequestException({
            error: "Reservation below minFillAmount",
            minFillAmount: intent.minFillAmount ?? "1",
            ...detail,
          });
        case "exceeds_remaining":
          throw new ConflictException({ error: "Reservation exceeds the unreserved remainder", ...detail });
        case "nothing_remaining":
          throw new ConflictException({ error: "Nothing left to reserve on this intent", ...detail });
        case "intent_not_open":
          throw new ConflictException({ error: "Intent is no longer open", ...detail });
      }
    }

    const fill = result.fill;
    this.log.info("partial-fill tranche reserved", {
      intentId: intent.intentId,
      solver,
      fillId: fill.fillId,
      reservedAmount: fill.reservedAmount,
      trancheDeadline: fill.deadline,
    });
    this.intents.appendAuditEntry(intent.intentId, "open", solver, "solver reserved tranche", {
      fillId: fill.fillId,
      reservedAmount: fill.reservedAmount,
      deadline: fill.deadline,
    });
    if (this.onchainEnabled) this.logOnchainMock("reserve_tranche", fill);
    const { intent: decorated, fillProgress } = await this.details(intent);
    await this.gateway.broadcast({
      type: "intent_tranche_reserved",
      intentId: intent.intentId,
      solver,
      fillId: fill.fillId,
      reservedAmount: fill.reservedAmount,
      deadline: fill.deadline,
      fillProgress,
    });
    return { fill, intent: decorated };
  }

  // ── fill ─────────────────────────────────────────────────────────────────

  /**
   * Record delivery of one tranche. `dstAmount` must be at least the
   * tranche's pro-rata `minDstAmount`. Settles the intent when it was the
   * last open piece.
   */
  async fillTranche(
    intent: Intent,
    fillId: string,
    solver: string,
    dstAmount: string,
    txHash: string | undefined,
    now: number,
  ): Promise<{ fill: IntentFill; intent: Intent; settled: boolean }> {
    const existing = await this.fills.findById(fillId);
    if (!existing || existing.intentId !== intent.intentId) throw new NotFoundException("Tranche not found");
    if (existing.solver !== solver) throw new ForbiddenException("Tranche is reserved by a different solver");
    if (existing.status !== "reserved") throw new ConflictException(`Tranche is ${existing.status}, cannot fill`);
    if (existing.deadline <= now) throw new GoneException("Tranche fill window has expired");

    let delivered: bigint;
    try {
      delivered = BigInt(dstAmount);
    } catch {
      throw new BadRequestException("dstAmount must be an integer string");
    }
    if (delivered < BigInt(existing.minDstAmount)) {
      throw new BadRequestException({
        error: "Tranche delivery below its pro-rata minimum",
        dstAmount,
        minDstAmount: existing.minDstAmount,
      });
    }

    const fill = await this.fills.markFilled(fillId, solver, {
      dstAmount: delivered.toString(),
      feeAmount: protocolFee(delivered).toString(),
      txHash,
      filledAt: now,
    });
    if (!fill) {
      // Lost a race — the sweeper slashed it at the deadline, or a duplicate request won.
      const current = await this.fills.findById(fillId);
      throw new ConflictException(`Tranche is ${current?.status ?? "unknown"}, cannot fill`);
    }

    await this.solvers.recordSuccessfulFill(solver, fill.dstAmount);
    this.intents.appendAuditEntry(intent.intentId, "open", solver, "solver filled tranche", {
      fillId,
      reservedAmount: fill.reservedAmount,
      dstAmount: fill.dstAmount,
      txHash,
    });
    if (this.onchainEnabled) this.logOnchainMock("fill_tranche", fill);

    const fills = await this.fills.listByIntent(intent.intentId);
    const progress = computeFillProgress(intent, fills);
    this.log.info("partial-fill tranche filled", {
      intentId: intent.intentId,
      solver,
      fillId,
      dstAmount: fill.dstAmount,
      filledAmount: progress.filledAmount,
      remainingAmount: progress.remainingAmount,
    });
    await this.gateway.broadcast({
      type: "intent_partially_filled",
      intentId: intent.intentId,
      solver,
      fillId,
      reservedAmount: fill.reservedAmount,
      dstAmount: fill.dstAmount,
      fillProgress: progress,
    });

    const alloc = allocation(intent.srcAmount, fills);
    let settled = false;
    if (alloc.remaining === 0n && alloc.reserved === 0n) {
      settled = (await this.settle(intent, fills, solver, "all tranches filled", now)) !== null;
    }
    const current = (await this.intents.get(intent.intentId)) ?? intent;
    return { fill, intent: { ...current, fillProgress: computeFillProgress(current, fills) }, settled };
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  /**
   * User cancel for a partial-fill intent (signature already verified).
   * Nothing filled → ordinary cancel. Something filled → the remainder is
   * cancelled and the intent settles to `filled`. Live reservations block the
   * cancel: a solver may already be delivering.
   *
   * @returns the updated intent, or null when it was no longer open.
   */
  async cancelRemainder(intent: Intent, user: string, now: number): Promise<{ intent: Intent | null; settled: boolean }> {
    const fills = await this.fills.listByIntent(intent.intentId);
    const alloc = allocation(intent.srcAmount, fills);
    if (alloc.reserved > 0n) {
      throw new ConflictException({
        error: "Cannot cancel while tranche reservations are outstanding",
        intentId: intent.intentId,
        reservedAmount: alloc.reserved.toString(),
        activeReservations: fills.filter((f) => f.status === "reserved").length,
      });
    }
    if (alloc.filled === 0n) {
      const cancelled = await this.intents.cancelIfOpen(intent.intentId);
      return { intent: cancelled, settled: false };
    }
    const last = [...fills].filter((f) => f.status === "filled").sort((a, b) => (b.filledAt ?? 0) - (a.filledAt ?? 0))[0];
    const settled = await this.settle(intent, fills, last.solver, `remainder cancelled by ${user}`, now);
    return { intent: settled ? { ...settled, fillProgress: computeFillProgress(settled, fills) } : null, settled: !!settled };
  }

  // ── sweeper ──────────────────────────────────────────────────────────────

  /**
   * Slash every live reservation whose deadline has passed — the solver loses
   * only that tranche, and the amount returns to the pool for others.
   * Optionally scoped to one intent (the expiry path). Returns the number slashed.
   */
  async slashExpiredReservations(now: number, intentId?: string): Promise<number> {
    const due = intentId
      ? (await this.fills.listByIntent(intentId)).filter((f) => f.status === "reserved" && f.deadline <= now)
      : await this.fills.findExpiredReservations(now);
    let slashed = 0;
    for (const candidate of due) {
      const fill = await this.fills.markSlashed(candidate.fillId, now);
      if (!fill) continue; // filled in the meantime — fill wins
      slashed += 1;
      await this.penalise(fill, now);
    }
    return slashed;
  }

  private async penalise(fill: IntentFill, now: number): Promise<void> {
    const reason = `partial-fill tranche ${fill.fillId} (${fill.reservedAmount} reserved) not filled before deadline`;
    this.log.warn("partial-fill tranche slashed", {
      intentId: fill.intentId,
      solver: fill.solver,
      fillId: fill.fillId,
      slashedAmount: fill.reservedAmount,
    });
    this.intents.appendAuditEntry(fill.intentId, "open", "system", "tranche reservation slashed", {
      fillId: fill.fillId,
      solver: fill.solver,
      slashedAmount: fill.reservedAmount,
    });
    try {
      await this.solvers.recordFailedFill(fill.solver, fill.intentId);
      await this.solvers.recordSlash(fill.solver, fill.intentId, reason, now);
      this.griefing?.recordUnfilled(fill.solver, fill.intentId, now);
      if (this.onchainEnabled && this.solverRegistry) {
        await this.solverRegistry.slashSolver({ solverAddress: fill.solver, intentId: fill.intentId, reason });
      } else {
        this.logOnchainMock("slash_tranche", fill);
      }
    } catch (err) {
      // The tranche is already marked slashed and returned to the pool; a
      // bookkeeping failure must not stop the sweep.
      this.log.error("partial-fill slash bookkeeping failed", { intentId: fill.intentId, fillId: fill.fillId, err });
    }
    const fills = await this.fills.listByIntent(fill.intentId);
    const intent = await this.intents.get(fill.intentId);
    await this.gateway.broadcast({
      type: "intent_tranche_slashed",
      intentId: fill.intentId,
      solver: fill.solver,
      fillId: fill.fillId,
      slashedAmount: fill.reservedAmount,
      ...(intent ? { fillProgress: computeFillProgress(intent, fills) } : {}),
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async settle(
    intent: Intent,
    fills: IntentFill[],
    solver: string,
    reason: string,
    now: number,
  ): Promise<Intent | null> {
    const filled = fills.filter((f) => f.status === "filled");
    const dstTotal = filled.reduce((sum, f) => sum + BigInt(f.dstAmount ?? "0"), 0n);
    const feeTotal = filled.reduce((sum, f) => sum + BigInt(f.feeAmount ?? "0"), 0n);
    const lastTx = [...filled].sort((a, b) => (b.filledAt ?? 0) - (a.filledAt ?? 0))[0]?.txHash;
    const settled = await this.intents.settlePartialFill(
      intent.intentId,
      solver,
      { fillAmount: dstTotal.toString(), feeAmount: feeTotal.toString(), txHash: lastTx, filledAt: now },
      now,
    );
    if (!settled) return null;
    this.intents.appendAuditEntry(intent.intentId, "filled", solver, reason, {
      fillAmount: dstTotal.toString(),
      tranches: filled.length,
    });
    this.log.info("partial-fill intent settled", {
      intentId: intent.intentId,
      solver,
      fillAmount: dstTotal.toString(),
      tranches: filled.length,
      reason,
    });
    await this.gateway.broadcast({
      type: "intent_filled",
      intentId: intent.intentId,
      solver,
      fillAmount: dstTotal.toString(),
      partial: true,
      fillProgress: computeFillProgress(settled, fills),
    });
    return settled;
  }

  /**
   * The settlement contract has no tranche entrypoints yet (issue #427 keeps
   * contract changes out of scope), so the on-chain leg is a logged no-op
   * even with `PARTIAL_FILLS_ONCHAIN_ENABLED=true`, except for slashing,
   * which the registry already supports per intent.
   */
  private logOnchainMock(operation: string, fill: IntentFill): void {
    this.log.debug("partial-fill on-chain leg mocked", {
      operation,
      intentId: fill.intentId,
      fillId: fill.fillId,
      solver: fill.solver,
    });
  }
}
