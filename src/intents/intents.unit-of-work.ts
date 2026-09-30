import { PrismaService } from "../prisma/prisma.service";
import { IIntentsRepository } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import {
  InMemoryOutboxRepository,
  IOutboxWriter,
  NewOutboxEntry,
  OutboxEntry,
} from "../soroban/outbox.repository";
import { PrismaOutboxRepository } from "../soroban/prisma-outbox.repository";

/** Injection token for {@link IIntentsUnitOfWork}. */
export const INTENTS_UNIT_OF_WORK = Symbol("INTENTS_UNIT_OF_WORK");

/** Repositories scoped to one unit of work. */
export interface IntentsTransaction {
  intents: IIntentsRepository;
  outbox: IOutboxWriter;
}

/**
 * Runs an intent mutation and its outbox rows as one atomic unit (issue #396),
 * so the database can never record a state change whose on-chain write was
 * silently dropped, or vice versa.
 */
export interface IIntentsUnitOfWork {
  run<T>(work: (tx: IntentsTransaction) => Promise<T>): Promise<T>;
}

/**
 * Prisma adapter: one interactive `$transaction` — the intent write and the
 * `onchain_outbox` insert commit or roll back together.
 */
export class PrismaIntentsUnitOfWork implements IIntentsUnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: (tx: IntentsTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((client) =>
      work({
        intents: new PrismaIntentsRepository(client),
        outbox: new PrismaOutboxRepository(client),
      }),
    );
  }
}

/**
 * In-memory adapter (dev/test). Outbox rows are buffered and only committed
 * when `work` resolves, so a throw after the enqueue never leaves an orphan
 * row. Intent writes are not rolled back — callers order their work so the
 * intent write is the last step that can fail (see IntentsService).
 */
export class InMemoryIntentsUnitOfWork implements IIntentsUnitOfWork {
  constructor(
    private readonly intents: IIntentsRepository,
    private readonly outbox: InMemoryOutboxRepository,
  ) {}

  async run<T>(work: (tx: IntentsTransaction) => Promise<T>): Promise<T> {
    const buffered: NewOutboxEntry[] = [];
    const writer: IOutboxWriter = {
      enqueue: async (entry) => {
        buffered.push(entry);
        // The row id is assigned on commit; callers inside the unit of work
        // must not depend on it.
        return { ...entry, id: "uncommitted" } as OutboxEntry;
      },
    };
    const result = await work({ intents: this.intents, outbox: writer });
    for (const entry of buffered) await this.outbox.enqueue(entry);
    return result;
  }
}
