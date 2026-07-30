import { ConfigService } from "@nestjs/config";
import { SolverRegistryService } from "./solver-registry.service";
import { AppConfig } from "../config/configuration";

function makeConfigService(overrides: Partial<AppConfig["stellar"]> = {}) {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    settlementContractId: "",
    solverRegistryContractId: "",
    signingKey: "",
    ...overrides,
  };
  const config: AppConfig = {
    nodeEnv: "test",
    port: 4000,
    stellar,
    corsOrigin: "*",
  };
  return {
    get: (key: string) => {
      const parts = key.split(".");
      // only "stellar.<field>" keys are used by this service
      return (config as unknown as Record<string, unknown>)[parts[0]] &&
        parts[0] === "stellar"
        ? (stellar as unknown as Record<string, unknown>)[parts[1]]
        : undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
}

describe("SolverRegistryService", () => {
  it("is not configured when the contract id and signing key are both empty (default)", () => {
    const service = new SolverRegistryService(makeConfigService());
    expect(service.isConfigured).toBe(false);
  });

  it("is not configured when only the contract id is set", () => {
    const service = new SolverRegistryService(
      makeConfigService({ solverRegistryContractId: "CABCDEF" }),
    );
    expect(service.isConfigured).toBe(false);
  });

  it("no-ops without contacting the network when unconfigured", async () => {
    const service = new SolverRegistryService(makeConfigService());
    const result = await service.slashSolver({
      solverAddress: "GSOLVER",
      intentId: "intent-1",
      reason: "missed deadline",
    });

    expect(result.submitted).toBe(false);
    expect(result.simulated).toBe(false);
    expect(result.detail).toMatch(/not configured/i);
  });
});
