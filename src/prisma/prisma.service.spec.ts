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
});
