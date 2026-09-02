import { Test, TestingModule } from "@nestjs/testing";
import { SolversService } from "./solvers.service";
import { InMemorySolversRepository } from "./in-memory-solvers.repository";
import { SOLVERS_REPOSITORY } from "./solvers.repository";
import { SEED_SOLVER_KEYPAIRS } from "./solvers.seed";

const ALPHA_ADDR = SEED_SOLVER_KEYPAIRS.ALPHA.publicKey();

/**
 * Issue #273 — SolversService.update() applies a partial patch to the mutable
 * profile fields only.
 */
describe("SolversService.update", () => {
  let service: SolversService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: SOLVERS_REPOSITORY, useClass: InMemorySolversRepository },
        SolversService,
      ],
    }).compile();
    service = module.get<SolversService>(SolversService);
  });

  it("updates only the fields present in the patch", async () => {
    const before = await service.get(ALPHA_ADDR);
    const updated = await service.update(ALPHA_ADDR, { name: "Alpha MM v2" });

    expect(updated?.name).toBe("Alpha MM v2");
    expect(updated?.supportedChains).toEqual(before?.supportedChains);
    expect(updated?.avgFillTime).toBe(before?.avgFillTime);
  });

  it("replaces array fields wholesale", async () => {
    const updated = await service.update(ALPHA_ADDR, {
      supportedChains: ["stellar", "base"],
      supportedTokens: ["XLM", "USDC"],
    });
    expect(updated?.supportedChains).toEqual(["stellar", "base"]);
    expect(updated?.supportedTokens).toEqual(["XLM", "USDC"]);
  });

  it("ignores undefined values instead of clearing existing data", async () => {
    const before = await service.get(ALPHA_ADDR);
    const updated = await service.update(ALPHA_ADDR, {
      name: undefined,
      avgFillTime: 42,
    });
    expect(updated?.name).toBe(before?.name);
    expect(updated?.avgFillTime).toBe(42);
  });

  it("never touches immutable fields", async () => {
    const before = await service.get(ALPHA_ADDR);
    const updated = await service.update(ALPHA_ADDR, { name: "x" });
    expect(updated?.address).toBe(before?.address);
    expect(updated?.bondAmount).toBe(before?.bondAmount);
    expect(updated?.fillsCompleted).toBe(before?.fillsCompleted);
    expect(updated?.fillsFailed).toBe(before?.fillsFailed);
    expect(updated?.totalVolume).toBe(before?.totalVolume);
    expect(updated?.registeredAt).toBe(before?.registeredAt);
    expect(updated?.isActive).toBe(before?.isActive);
  });

  it("returns undefined for an unknown address", async () => {
    expect(await service.update("NOPE", { name: "ghost" })).toBeUndefined();
  });
});
