import { Global, Injectable, Logger, Module } from "@nestjs/common";
import { Subject, Observable } from "rxjs";

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

/** A single guardian state transition, broadcast to stream subscribers. */
export interface GuardianStateEvent {
  type: "pause" | "solver_suspended" | "param_frozen";
  active: boolean;
  target?: string;
  reason: string;
  since: string;
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
  private readonly events = new Subject<GuardianStateEvent>();

  /** Active guardian pause, or null. */
  pauseRef(): StateRef | null {
    return this.pause;
  }

  /** Stream of guardian state transitions (issue #614). */
  stream(): Observable<GuardianStateEvent> {
    return this.events.asObservable();
  }

  /** Current state as a list of events, for initial-state-on-connect. */
  currentEvents(): GuardianStateEvent[] {
    const out: GuardianStateEvent[] = [];
    if (this.pause) {
      out.push({
        type: "pause",
        active: true,
        reason: this.pause.reason,
        since: this.pause.since,
      });
    }
    for (const [target, ref] of this.suspendedSolvers) {
      out.push({
        type: "solver_suspended",
        active: true,
        target,
        reason: ref.reason,
        since: ref.since,
      });
    }
    for (const [target, ref] of this.frozenParams) {
      out.push({
        type: "param_frozen",
        active: true,
        target,
        reason: ref.reason,
        since: ref.since,
      });
    }
    return out;
  }

  setPause(active: boolean, ref: StateRef): void {
    this.pause = active ? ref : null;
    this.logger.warn(`[guardian] protocol pause ${active ? "ON" : "OFF"} (${ref.reason})`);
    this.emit({ type: "pause", active, reason: ref.reason, since: ref.since });
  }

  isSolverSuspended(address: string): boolean {
    return this.suspendedSolvers.has(address);
  }

  setSolverSuspended(address: string, active: boolean, ref: StateRef): void {
    if (active) this.suspendedSolvers.set(address, ref);
    else this.suspendedSolvers.delete(address);
    this.logger.warn(`[guardian] solver ${address} suspension ${active ? "ON" : "OFF"} (${ref.reason})`);
    this.emit({ type: "solver_suspended", active, target: address, reason: ref.reason, since: ref.since });
  }

  isParamFrozen(key: string): boolean {
    return this.frozenParams.has(key) || this.frozenParams.has(ALL_PARAMS);
  }

  setParamFrozen(key: string, active: boolean, ref: StateRef): void {
    if (active) this.frozenParams.set(key, ref);
    else this.frozenParams.delete(key);
    this.logger.warn(`[guardian] parameter ${key} freeze ${active ? "ON" : "OFF"} (${ref.reason})`);
    this.emit({ type: "param_frozen", active, target: key, reason: ref.reason, since: ref.since });
  }

  snapshot(): GuardianStateSnapshot {
    return {
      pause: this.pause,
      suspendedSolvers: Object.fromEntries(this.suspendedSolvers),
      frozenParams: Object.fromEntries(this.frozenParams),
    };
  }

  private emit(event: GuardianStateEvent): void {
    this.events.next(event);
  }
}

/** Global so the kill switch, solvers and flags can consult guardian state without import cycles. */
@Global()
@Module({
  providers: [GuardianStateService],
  exports: [GuardianStateService],
})
export class GuardianStateModule {}
