import { Test, TestingModule } from "@nestjs/testing";
import { DatabaseHealthService } from "./database-health.service";
import { PrismaService } from "../prisma/prisma.service";

/** Minimal PrismaService stub — only $queryRaw is needed by the health probe. */
const makePrismaMock = (impl: () => Promise<unknown>) =>
  ({
    $queryRaw: impl,
  }) as unknown as PrismaService;

describe("DatabaseHealthService", () => {
  async function buildService(prismaMock: PrismaService): Promise<DatabaseHealthService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseHealthService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    return module.get<DatabaseHealthService>(DatabaseHealthService);
  }

  it("returns status ok with a non-negative latencyMs when the query succeeds", async () => {
    const service = await buildService(makePrismaMock(() => Promise.resolve([{ "?column?": 1 }])));

    const result = await service.check();

    expect(result.status).toBe("ok");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("returns status unreachable with an error message when the query rejects", async () => {
    const service = await buildService(
      makePrismaMock(() => Promise.reject(new Error("ECONNREFUSED"))),
    );

    const result = await service.check();

    expect(result.status).toBe("unreachable");
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.latencyMs).toBeUndefined();
  });

  it("returns status unreachable when the query exceeds the timeout", async () => {
    jest.useFakeTimers();

    const neverResolves = makePrismaMock(
      () => new Promise<never>(() => { /* intentionally hangs */ }),
    );
    const service = await buildService(neverResolves);

    const checkPromise = service.check();

    // Advance time past the 3-second probe timeout.
    jest.advanceTimersByTime(3_100);

    const result = await checkPromise;

    expect(result.status).toBe("unreachable");
    expect(result.error).toMatch(/timed out/i);
    expect(result.latencyMs).toBeUndefined();

    // Clear all pending timers before restoring real timers to prevent the
    // "open handle" warning from the hanging query promise.
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("does not throw when $queryRaw is not a function (missing DB client)", async () => {
    const brokenMock = {} as unknown as PrismaService;
    const service = await buildService(brokenMock);

    await expect(service.check()).resolves.toMatchObject({ status: "unreachable" });
  });
});
