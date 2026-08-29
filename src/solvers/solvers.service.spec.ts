import { Test, TestingModule } from "@nestjs/testing";
import { SolversService } from "./solvers.service";
import { InMemorySolversRepository } from "./in-memory-solvers.repository";
import { SOLVERS_REPOSITORY } from "./solvers.repository";
import { SEED_SOLVER_KEYPAIRS } from "./solvers.seed";

const ALPHA_ADDR = SEED_SOLVER_KEYPAIRS.ALPHA.publicKey();

/**
 * SolversService unit tests.
 *
 * A real InMemorySolversRepository is provided under the SOLVERS_REPOSITORY
 * token — identical to how SolversModule wires things in production.
 */
describe("SolversService", () => {
  let service: SolversService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: SOLVERS_REPOSITORY,
          useClass: InMemorySolversRepository,
        },
        SolversService,
      ],
    }).compile();

    service = module.get<SolversService>(SolversService);
  });

  it("seeds 3 solvers on construction", async () => {
    expect(await service.getAll()).toHaveLength(3);
  });

  it("get returns the matching solver by address", async () => {
    const solver = await service.get(ALPHA_ADDR);
    expect(solver?.name).toBe("Alpha Market Making");
  });

  it("get returns undefined for an unknown address", async () => {
    expect(await service.get("NOPE")).toBeUndefined();
  });

  it("register adds a new solver with zeroed fill/volume counters", async () => {
    const before = (await service.getAll()).length;
    const registered = await service.register({
      address: "SOLVER_DELTA",
      name: "Delta Test",
      bondAmount: "1000",
      avgFillTime: 10,
      isActive: true,
      supportedChains: ["stellar"],
      supportedTokens: ["XLM"],
    });

    expect(registered.fillsCompleted).toBe(0);
    expect(registered.fillsFailed).toBe(0);
    expect(registered.totalVolume).toBe("0");
    expect(registered.registeredAt).toBeGreaterThan(0);
    expect(await service.getAll()).toHaveLength(before + 1);
    expect((await service.get("SOLVER_DELTA"))?.name).toBe("Delta Test");
  });

  it("register sets registeredAt to the current unix timestamp", async () => {
    const before = Math.floor(Date.now() / 1000);
    const registered = await service.register({
      address: "SOLVER_TS",
      name: "Timestamp Test",
      bondAmount: "0",
      avgFillTime: 0,
      isActive: true,
      supportedChains: [],
      supportedTokens: [],
    });
    expect(registered.registeredAt).toBeGreaterThanOrEqual(before);
  });

  it("register overwrites an existing solver with the same address", async () => {
    const before = (await service.getAll()).length;
    await service.register({
      address: ALPHA_ADDR,
      name: "Replaced Alpha",
      bondAmount: "1",
      avgFillTime: 1,
      isActive: false,
      supportedChains: [],
      supportedTokens: [],
    });

    expect(await service.getAll()).toHaveLength(before);
    expect((await service.get(ALPHA_ADDR))?.name).toBe("Replaced Alpha");
  });

  it("marks a solver inactive when deregistered", async () => {
    const solver = await service.deregister(ALPHA_ADDR);

    expect(solver?.isActive).toBe(false);
    expect((await service.get(ALPHA_ADDR))?.isActive).toBe(false);
  });

  it("marks a solver active when it comes online", async () => {
    await service.markLive(ALPHA_ADDR);

    expect((await service.get(ALPHA_ADDR))?.isActive).toBe(true);
  });
});
