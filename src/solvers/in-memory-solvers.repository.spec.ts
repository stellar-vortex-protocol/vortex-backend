import { InMemorySolversRepository } from "./in-memory-solvers.repository";
import { SolverRecord } from "./solvers.types";
import { SEED_SOLVER_KEYPAIRS } from "./solvers.seed";

/** Minimal helper that builds a valid SolverRecord for test cases. */
function makeSolver(overrides: Partial<SolverRecord> = {}): SolverRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    address: "SOLVER_TEST",
    name: "Test Solver",
    bondAmount: "1000",
    fillsCompleted: 0,
    fillsFailed: 0,
    totalVolume: "0",
    avgFillTime: 10,
    isActive: true,
    registeredAt: now,
    supportedChains: ["ethereum"],
    supportedTokens: ["USDC"],
    ...overrides,
  };
}

describe("InMemorySolversRepository", () => {
  let repo: InMemorySolversRepository;

  beforeEach(() => {
    repo = new InMemorySolversRepository();
  });

  // ── seed ──────────────────────────────────────────────────────────────────

  it("seeds 3 solvers on construction", () => {
    expect(repo.findAll()).toHaveLength(3);
  });

  it("seeded solvers include ALPHA, BETA, GAMMA addresses", () => {
    const addresses = repo.findAll().map((s) => s.address);
    expect(addresses).toContain(SEED_SOLVER_KEYPAIRS.ALPHA.publicKey());
    expect(addresses).toContain(SEED_SOLVER_KEYPAIRS.BETA.publicKey());
    expect(addresses).toContain(SEED_SOLVER_KEYPAIRS.GAMMA.publicKey());
  });

  // ── save ──────────────────────────────────────────────────────────────────

  it("save persists and returns the solver", () => {
    const solver = makeSolver({ address: "SOLVER_NEW" });
    const saved = repo.save(solver);

    expect(saved).toEqual(solver);
    expect(repo.findByAddress("SOLVER_NEW")).toEqual(solver);
  });

  it("save with the same address overwrites the existing record", () => {
    const original = makeSolver({ address: "SOLVER_ALPHA", name: "Original" });
    repo.save(original);
    repo.save({ ...original, name: "Updated" });

    expect(repo.findByAddress("SOLVER_ALPHA")?.name).toBe("Updated");
    // Count stays the same — no duplicate created
    expect(repo.findAll().filter((s) => s.address === "SOLVER_ALPHA")).toHaveLength(1);
  });

  it("save increments total count when address is new", () => {
    const before = repo.findAll().length;
    repo.save(makeSolver({ address: "SOLVER_EXTRA" }));
    expect(repo.findAll()).toHaveLength(before + 1);
  });

  // ── findByAddress ─────────────────────────────────────────────────────────

  it("findByAddress returns undefined for a missing address", () => {
    expect(repo.findByAddress("NOPE")).toBeUndefined();
  });

  it("findByAddress returns the correct record", () => {
    const solver = makeSolver({ address: "SOLVER_FIND" });
    repo.save(solver);
    expect(repo.findByAddress("SOLVER_FIND")).toEqual(solver);
  });

  // ── findAll ───────────────────────────────────────────────────────────────

  it("findAll returns all stored solvers", () => {
    const before = repo.findAll().length;
    repo.save(makeSolver({ address: "SOLVER_A1" }));
    repo.save(makeSolver({ address: "SOLVER_A2" }));
    expect(repo.findAll()).toHaveLength(before + 2);
  });

  it("findAll returns a snapshot — mutating the result does not affect the store", () => {
    const all = repo.findAll();
    all.pop();
    expect(repo.findAll()).toHaveLength(3); // seed count unchanged
  });
});
