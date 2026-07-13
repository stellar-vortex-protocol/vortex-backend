import { SolversService } from "./solvers.service";

describe("SolversService", () => {
  let service: SolversService;

  beforeEach(() => {
    service = new SolversService();
  });

  it("seeds 3 solvers on construction", () => {
    expect(service.getAll()).toHaveLength(3);
  });

  it("get returns the matching solver by address", () => {
    const solver = service.get("SOLVER_ALPHA");
    expect(solver?.name).toBe("Alpha Market Making");
  });

  it("get returns undefined for an unknown address", () => {
    expect(service.get("NOPE")).toBeUndefined();
  });

  it("register adds a new solver with zeroed fill/volume counters", () => {
    const before = service.getAll().length;
    const registered = service.register({
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
    expect(service.getAll()).toHaveLength(before + 1);
    expect(service.get("SOLVER_DELTA")?.name).toBe("Delta Test");
  });

  it("register overwrites an existing solver with the same address", () => {
    const before = service.getAll().length;
    service.register({
      address: "SOLVER_ALPHA",
      name: "Replaced Alpha",
      bondAmount: "1",
      avgFillTime: 1,
      isActive: false,
      supportedChains: [],
      supportedTokens: [],
    });

    expect(service.getAll()).toHaveLength(before);
    expect(service.get("SOLVER_ALPHA")?.name).toBe("Replaced Alpha");
  });
});
