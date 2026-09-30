/**
 * Solver-intent capability matcher (issue #436)
 * ───────────────────────────────────────────────
 * Provides a fast per-solver predicate that decides whether an open intent
 * is eligible for a given solver based on:
 *   • supported source chains
 *   • supported source tokens (by symbol)
 *   • remaining bond capacity (> 0)
 *
 * The predicate is pre-compiled once per solver connection/update and is
 * applied synchronously during WS fan-out to keep CPU overhead low even
 * at large subscriber counts.
 *
 * An intent index keyed by (srcChain, srcToken.symbol) is maintained so we
 * can go from "solver connected" → "eligible intents" in O(supported-chains ×
 * supported-tokens) instead of O(all-open-intents).  The same index is used
 * by GET /solvers/:address/eligible-intents (see solvers.controller.ts) so
 * both surfaces stay in sync automatically.
 */

import { Injectable } from "@nestjs/common";
import { Intent, SupportedChain } from "./intents.types";
import { SolverRecord } from "../solvers/solvers.types";
import { IntentsService } from "./intents.service";
import { logger } from "../common/logger";

export interface SolverMatchPredicate {
  /** Returns true iff an open intent is eligible for this solver. */
  matches(intent: Intent): boolean;
  /** The solver address this predicate was compiled for. */
  solverAddress: string;
  /** Snapshot of the solver's capabilities at compile time. */
  supportedChains: SupportedChain[];
  supportedTokens: string[];
  bondAmount: string;
}

/**
 * Builds a match predicate for a solver.  The predicate is a plain closure so
 * it is cheap to evaluate (no object allocations per intent check).
 */
export function buildMatchPredicate(solver: SolverRecord): SolverMatchPredicate {
  // A missing capability list means the solver declared nothing, so it matches
  // nothing.  Defaulting to an empty set (rather than trusting the field to be
  // present) keeps a partially-populated solver record from widening its own
  // feed and keeps this hot path from throwing mid-broadcast.
  const supportedChains = Array.isArray(solver.supportedChains) ? solver.supportedChains : [];
  const supportedTokens = Array.isArray(solver.supportedTokens) ? solver.supportedTokens : [];
  const chainSet = new Set<string>(supportedChains);
  const tokenSet = new Set<string>(supportedTokens.map((t) => t.toLowerCase()));
  // A missing / unparseable bond is treated as "no bond", so the solver matches
  // nothing rather than throwing (or matching) on malformed data.
  let hasBond = false;
  try {
    hasBond = BigInt(solver.bondAmount) > 0n;
  } catch {
    hasBond = false;
  }

  return {
    solverAddress: solver.address,
    supportedChains: [...supportedChains],
    supportedTokens: [...supportedTokens],
    bondAmount: solver.bondAmount,
    matches(intent: Intent): boolean {
      if (!hasBond) return false;
      if (!chainSet.has(intent.srcChain)) return false;
      const symbol =
        typeof intent.srcToken === "object" && intent.srcToken !== null
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ((intent.srcToken as any).symbol as string | undefined)
          : undefined;
      return symbol ? tokenSet.has(symbol.toLowerCase()) : false;
    },
  };
}

/**
 * Intent index keyed by `${srcChain}:${srcTokenSymbol.toLowerCase()}`.
 *
 * Maintained by IntentCapabilityIndex so that:
 *   • Fan-out can skip intents that the solver definitely cannot fill.
 *   • GET /solvers/:address/eligible-intents returns O(1) candidates without
 *     scanning all open intents.
 */
@Injectable()
export class IntentCapabilityIndex {
  // chain:token → Set of open intentIds
  private readonly index = new Map<string, Set<string>>();
  // intentId → Intent (secondary lookup)
  private readonly byId = new Map<string, Intent>();

  constructor(private readonly intentsService: IntentsService) {}

  private static key(chain: string, tokenSymbol: string): string {
    return `${chain}:${tokenSymbol.toLowerCase()}`;
  }

  /**
   * Rebuild the full index from scratch from current open intents.
   * Called on module init and after bulk state changes.
   */
  async rebuild(): Promise<void> {
    this.index.clear();
    this.byId.clear();
    const open = await this.intentsService.getByState("open");
    for (const intent of open) {
      this.addIntent(intent);
    }
    logger.debug(
      `[intent-index] rebuilt: ${open.length} open intents, ${this.index.size} bucket(s)`,
    );
  }

  /** Add (or refresh) a single intent in the index. */
  addIntent(intent: Intent): void {
    const symbol = this.getSymbol(intent);
    if (!symbol) return;
    const k = IntentCapabilityIndex.key(intent.srcChain, symbol);
    if (!this.index.has(k)) this.index.set(k, new Set());
    this.index.get(k)!.add(intent.intentId);
    this.byId.set(intent.intentId, intent);
  }

  /** Remove an intent from the index (call when it leaves the open state). */
  removeIntent(intentId: string): void {
    const intent = this.byId.get(intentId);
    if (!intent) return;
    const symbol = this.getSymbol(intent);
    if (symbol) {
      const k = IntentCapabilityIndex.key(intent.srcChain, symbol);
      this.index.get(k)?.delete(intentId);
    }
    this.byId.delete(intentId);
  }

  /**
   * Return all currently-indexed open intents that match the solver's
   * capabilities.  Used by GET /solvers/:address/eligible-intents and by
   * the WS snapshot sent immediately after solver auth.
   */
  getEligibleFor(solver: SolverRecord): Intent[] {
    if (BigInt(solver.bondAmount) <= 0n) return [];
    const result: Intent[] = [];
    for (const chain of solver.supportedChains) {
      for (const token of solver.supportedTokens) {
        const k = IntentCapabilityIndex.key(chain, token);
        const ids = this.index.get(k);
        if (!ids) continue;
        for (const id of ids) {
          const intent = this.byId.get(id);
          if (intent) result.push(intent);
        }
      }
    }
    return result;
  }

  private getSymbol(intent: Intent): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sym = (intent.srcToken as any)?.symbol;
    return typeof sym === "string" && sym.length > 0 ? sym : undefined;
  }
}
