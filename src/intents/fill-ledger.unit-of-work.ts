import { PrismaService } from "../prisma/prisma.service";
import { ISolverFillsWriter } from "../solvers/solver-fills.repository";
import { PrismaSolverFillsRepository } from "../solvers/prisma-solver-fills.repository";
import { IIntentsRepository } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";

/** Injection token for {@link IFillLedgerUnitOfWork}. */
export const FILL_LEDGER_UNIT_OF_WORK = Symbol("FILL_LEDGER_UNIT_OF_WORK");

/** Repositories scoped to one fill/failure transition. */
export interface FillLedgerTransaction {
  intents: IIntentsRepository;
  fills: ISolverFillsWriter;
}

/**
 * Runs an `accepted → filled` / `accepted → slashed` transition and its
 * `solver_fills` row as one atomic unit (issue #417): a committed transition
 * always has its row, and a rolled-back one never does.
 */
export interface IFillLedgerUnitOfWork {
  run<T>(work: (tx: FillLedgerTransaction) => Promise<T>): Promise<T>;
}

/** Prisma adapter: one interactive `$transaction` over `intents` + `solver_fills`. */
export class PrismaFillLedgerUnitOfWork implements IFillLedgerUnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: (tx: FillLedgerTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((client) =>
      work({
        intents: new PrismaIntentsRepository(client),
        fills: new PrismaSolverFillsRepository(client),
      }),
    );
  }
}

/**
 * In-memory adapter (dev/test). Both stores are process-local and the
 * transition's conditional write is synchronous, so the only step that can
 * fail after the write is the row insert, which cannot throw for a valid row.
 */
export class InMemoryFillLedgerUnitOfWork implements IFillLedgerUnitOfWork {
  constructor(
    private readonly intents: IIntentsRepository,
    private readonly fills: ISolverFillsWriter,
  ) {}

  run<T>(work: (tx: FillLedgerTransaction) => Promise<T>): Promise<T> {
    return work({ intents: this.intents, fills: this.fills });
  }
}
