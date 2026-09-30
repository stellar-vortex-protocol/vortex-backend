import { PrismaService } from "../prisma/prisma.service";
import { InMemoryOutboxRepository } from "../soroban/outbox.repository";
import { PrismaOutboxRepository } from "../soroban/prisma-outbox.repository";
import { InMemoryIntentsRepository } from "./intents.repository";
import { InMemoryIntentsUnitOfWork, PrismaIntentsUnitOfWork } from "./intents.unit-of-work";
import { PrismaIntentsRepository } from "./prisma-intents.repository";

describe("IntentsUnitOfWork (#396)", () => {
  it("Prisma: runs the work in one $transaction with repositories bound to the tx client", async () => {
    const txClient = { intent: {}, onchainOutbox: {} };
    const prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txClient)),
    } as unknown as PrismaService;

    const result = await new PrismaIntentsUnitOfWork(prisma).run(async ({ intents, outbox }) => {
      expect(intents).toBeInstanceOf(PrismaIntentsRepository);
      expect(outbox).toBeInstanceOf(PrismaOutboxRepository);
      expect((intents as unknown as { prisma: unknown }).prisma).toBe(txClient);
      expect((outbox as unknown as { prisma: unknown }).prisma).toBe(txClient);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("Prisma: a throw inside the work propagates (so $transaction rolls back)", async () => {
    const prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    } as unknown as PrismaService;
    await expect(
      new PrismaIntentsUnitOfWork(prisma).run(async () => {
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
  });

  it("in-memory: commits buffered outbox rows only when the work succeeds", async () => {
    const outbox = new InMemoryOutboxRepository();
    const uow = new InMemoryIntentsUnitOfWork(new InMemoryIntentsRepository(), outbox);
    const entry = { intentId: "i1", operation: "create_intent" as const, payload: {} };

    await expect(
      uow.run(async (tx) => {
        await tx.outbox.enqueue(entry);
        throw new Error("intent write failed");
      }),
    ).rejects.toThrow();
    expect(await outbox.findByIntent("i1")).toEqual([]);

    await uow.run(async (tx) => {
      await tx.outbox.enqueue(entry);
      expect(await outbox.findByIntent("i1")).toEqual([]); // not visible until commit
    });
    expect(await outbox.findByIntent("i1")).toHaveLength(1);
  });
});
