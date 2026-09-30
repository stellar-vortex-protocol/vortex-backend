import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "./prisma.service";

/**
 * Unit tests for PrismaService.
 *
 * PrismaClient's $connect / $disconnect are mocked to keep the suite
 * self-contained — no live database required.
 */
describe("PrismaService", () => {
  let service: PrismaService;

  // Track lifecycle call counts so we can assert they were invoked.
  const connectSpy = jest.fn().mockResolvedValue(undefined);
  const disconnectSpy = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);

    // Replace the real $connect / $disconnect with spies before lifecycle hooks run.
    service.$connect = connectSpy;
    service.$disconnect = disconnectSpy;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("is defined", () => {
    expect(service).toBeDefined();
  });

  it("calls $connect on onModuleInit", async () => {
    await service.onModuleInit();
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("calls $disconnect on onModuleDestroy", async () => {
    await service.onModuleDestroy();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it("extends PrismaClient (has query methods available)", () => {
    // We only verify the shape here — not calling the methods since there is no
    // database in unit tests.  Integration tests would cover actual queries.
    expect(typeof service.intent.findMany).toBe("function");
    expect(typeof service.solver.findMany).toBe("function");
    expect(typeof service.token.findMany).toBe("function");
  });

  // ── statement_timeout helpers (issue #476) ──────────────────────────────

  describe("withTimeout / withDefaultTimeout / withBatchTimeout / withStatsTimeout", () => {
    /**
     * Stub out $transaction to simulate the callback-form used by withTimeout.
     * The stub calls the callback with a fake tx client that records the
     * SET LOCAL statement it received.
     */
    function mockTransaction(service: PrismaService) {
      const statements: string[] = [];
      const fakeTx = {
        $executeRawUnsafe: jest.fn().mockImplementation((sql: string) => {
          statements.push(sql);
          return Promise.resolve();
        }),
      };
      service.$transaction = jest.fn().mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
      );
      return { statements, fakeTx };
    }

    it("withTimeout executes SET LOCAL statement_timeout with the given ms value", async () => {
      const { statements } = mockTransaction(service);

      let txCallbackInvoked = false;
      await service.withTimeout(1234, async (_tx) => {
        txCallbackInvoked = true;
        return "ok";
      });

      expect(txCallbackInvoked).toBe(true);
      expect(statements).toContain("SET LOCAL statement_timeout = 1234");
    });

    it("withDefaultTimeout uses DB_QUERY_TIMEOUT_MS (5000) by default", async () => {
      delete process.env.DB_QUERY_TIMEOUT_MS;
      const { statements } = mockTransaction(service);

      await service.withDefaultTimeout(async (_tx) => "ok");

      expect(statements[0]).toBe("SET LOCAL statement_timeout = 5000");
    });

    it("withDefaultTimeout respects DB_QUERY_TIMEOUT_MS env override", async () => {
      process.env.DB_QUERY_TIMEOUT_MS = "3000";
      const { statements } = mockTransaction(service);

      await service.withDefaultTimeout(async (_tx) => "ok");

      expect(statements[0]).toBe("SET LOCAL statement_timeout = 3000");
      delete process.env.DB_QUERY_TIMEOUT_MS;
    });

    it("withBatchTimeout uses DB_BATCH_QUERY_TIMEOUT_MS (10000) by default", async () => {
      delete process.env.DB_BATCH_QUERY_TIMEOUT_MS;
      const { statements } = mockTransaction(service);

      await service.withBatchTimeout(async (_tx) => "ok");

      expect(statements[0]).toBe("SET LOCAL statement_timeout = 10000");
    });

    it("withStatsTimeout uses DB_STATS_QUERY_TIMEOUT_MS (15000) by default", async () => {
      delete process.env.DB_STATS_QUERY_TIMEOUT_MS;
      const { statements } = mockTransaction(service);

      await service.withStatsTimeout(async (_tx) => "ok");

      expect(statements[0]).toBe("SET LOCAL statement_timeout = 15000");
    });

    it("withTimeout propagates the return value of the callback", async () => {
      mockTransaction(service);

      const result = await service.withTimeout(1000, async (_tx) => 42);

      expect(result).toBe(42);
    });

    it("withTimeout propagates errors thrown by the callback", async () => {
      mockTransaction(service);

      await expect(
        service.withTimeout(1000, async (_tx) => {
          throw new Error("query failed");
        }),
      ).rejects.toThrow("query failed");
    });
  });
});
