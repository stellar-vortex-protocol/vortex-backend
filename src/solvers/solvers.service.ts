import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { SolverRecord } from "./solvers.types";
import { buildSeedSolvers } from "./solvers.seed";

/** How often (ms) to emit a store-size log. Default: 60 s. */
const STORE_SIZE_LOG_INTERVAL_MS = 60_000;

@Injectable()
export class SolversService implements OnModuleDestroy {
  private readonly logger = new Logger(SolversService.name);
  private readonly solvers = new Map<string, SolverRecord>();
  private readonly sizeLogTimer: NodeJS.Timeout;

  constructor() {
    this.seed();
    this.sizeLogTimer = setInterval(() => this.logStoreSize(), STORE_SIZE_LOG_INTERVAL_MS);
    // Allow the process to exit even if the timer is still active.
    this.sizeLogTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sizeLogTimer);
  }

  /** Logs the current solver map size so unbounded growth is observable. */
  logStoreSize(): void {
    this.logger.log(`[store-monitor] solvers map size: ${this.solvers.size}`);
  }

  getAll(): SolverRecord[] {
    return [...this.solvers.values()];
  }

  get(address: string): SolverRecord | undefined {
    return this.solvers.get(address);
  }

  register(
    data: Omit<SolverRecord, "registeredAt" | "fillsCompleted" | "fillsFailed" | "totalVolume">,
  ): SolverRecord {
    const solver: SolverRecord = {
      ...data,
      fillsCompleted: 0,
      fillsFailed: 0,
      totalVolume: "0",
      registeredAt: Math.floor(Date.now() / 1000),
    };
    this.solvers.set(solver.address, solver);
    return solver;
  }

  private seed() {
    for (const s of buildSeedSolvers()) {
      this.solvers.set(s.address, s);
    }
  }
}
