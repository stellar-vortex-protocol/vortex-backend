import { Global, Injectable, Logger, Module } from "@nestjs/common";

/** Reference to the guardian action that set a state. */
export interface StateRef {
  since: string;
  reason: string;
  /** Guardian action id (Soroban event id). */
  actionId?: string;
  txHash?: string;
}

export interface GuardianStateSnapshot {
  pause: StateRef | null;
  suspendedSolvers: Record<string, StateRef>;
  frozenParams: Record<string, StateRef>;
}

/** Target that freezes every runtime parameter. */
export const ALL_PARAMS = "*";

/**
 * Backend policy state derived from on-chain guardian actions (issue #507).
 *
 * Kept separate from the operator kill switch (src/killswitch/, #477) so the
 * two sources never overwrite each other: KillSwitchService treats an active
 * guardian pause as a global switch, so the protocol is paused while *either*
 * is active and both must clear. Only guardian events (or an audited
 * superadmin override in GuardianService) change this state.
 */
@Injectable()
export class GuardianStateService {
  private readonly logger = new Logger(GuardianStateService.name);
  private pause: StateRef | null = null;
  private readonly suspendedSolvers = new Map<string, StateRef>();
  private readonly frozenParams = new Map<string, StateRef>();

  /** Active guardian pause, or null. */
  pauseRef(): StateRef | null {
    return this.pause;
  }

  setPause(active: boolean, ref: StateRef): void {
    this.pause = active ? ref : null;
    this.logger.warn(`[guardian] protocol pause ${active ? "ON" : "OFF"} (${ref.reason})`);
  }

  isSolverSuspended(address: string): boolean {
    return this.suspendedSolvers.has(address);
  }

  setSolverSuspended(address: string, active: boolean, ref: StateRef): void {
    if (active) this.suspendedSolvers.set(address, ref);
    else this.suspendedSolvers.delete(address);
    this.logger.warn(`[guardian] solver ${address} suspension ${active ? "ON" : "OFF"} (${ref.reason})`);
  }

  isParamFrozen(key: string): boolean {
    return this.frozenParams.has(key) || this.frozenParams.has(ALL_PARAMS);
  }

  setParamFrozen(key: string, active: boolean, ref: StateRef): void {
    if (active) this.frozenParams.set(key, ref);
    else this.frozenParams.delete(key);
    this.logger.warn(`[guardian] parameter ${key} freeze ${active ? "ON" : "OFF"} (${ref.reason})`);
  }

  snapshot(): GuardianStateSnapshot {
    return {
      pause: this.pause,
      suspendedSolvers: Object.fromEntries(this.suspendedSolvers),
      frozenParams: Object.fromEntries(this.frozenParams),
    };
  }
}

/** Global so the kill switch, solvers and flags can consult guardian state without import cycles. */
@Global()
@Module({
  providers: [GuardianStateService],
  exports: [GuardianStateService],
})
export class GuardianStateModule {}
