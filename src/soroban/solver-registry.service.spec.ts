import { ConfigService } from "@nestjs/config";
import { SolverRegistryService } from "./solver-registry.service";
import { AppConfig } from "../config/configuration";

function makeConfigService(
  overrides: Partial<AppConfig["stellar"]> = {},
  appOverrides: Partial<Pick<AppConfig, "onchainDryRun">> = {},
) {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    settlementContractId: "",
    solverRegistryContractId: "",
    signerSecretKey: "",
    signingKey: "",
    feePercentile: "p50",
    ...overrides,
  };
  const config: AppConfig = {
    nodeEnv: "test",
    port: 4000,
    databaseUrl: "postgresql://vortex:vortex@localhost:5432/vortex?schema=public",
    stellar,
    onchainIntentsEnabled: false,
    intentRetentionDays: 30,
    intentRetentionSweepMs: 60000,
    // Default to dry-run true for tests (safe default)
    onchainDryRun: appOverrides.onchainDryRun ?? true,
    corsOrigin: "*",
    wsMaxConnections: 1000,
    wsBackplane: "memory",
    redisUrl: "redis://localhost:6379",
  };
  return {
    get: (key: string) => {
      if (key === "onchainDryRun") return config.onchainDryRun;
      const parts = key.split(".");
      return (config as unknown as Record<string, unknown>)[parts[0]] && parts[0] === "stellar"
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

  it("no-ops without contacting the network when unconfigured (dry-run=true)", async () => {
    const service = new SolverRegistryService(makeConfigService());
    const result = await service.slashSolver({
      solverAddress: "GSOLVER",
      intentId: "intent-1",
      reason: "missed deadline",
    });

    expect(result.submitted).toBe(false);
    expect(result.simulated).toBe(false);
    // In dry-run mode, dryRun flag is true
    expect(result.dryRun).toBe(true);
  });
});

// ── #260: dry-run flag behaviour ─────────────────────────────────────────────

describe("SolverRegistryService — dry-run flag (#260)", () => {
  it("returns dryRun:true without simulating when ONCHAIN_DRY_RUN=true", async () => {
    const service = new SolverRegistryService(
      makeConfigService(
        { solverRegistryContractId: "CTEST123", signingKey: "S" + "A".repeat(55) },
        { onchainDryRun: true },
      ),
    );

    const result = await service.slashSolver({
      solverAddress: "GSOLVER",
      intentId: "intent-1",
      reason: "missed deadline",
    });

    expect(result.submitted).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.detail).toMatch(/ONCHAIN_DRY_RUN=true/);
  });

  it("returns dryRun:false when ONCHAIN_DRY_RUN=false and service is not fully configured", async () => {
    // With dryRun=false but contract not configured → falls through to no-op
    const service = new SolverRegistryService(
      makeConfigService({}, { onchainDryRun: false }),
    );

    const result = await service.slashSolver({
      solverAddress: "GSOLVER",
      intentId: "intent-1",
      reason: "missed deadline",
    });

    expect(result.submitted).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.detail).toMatch(/not configured/i);
  });
});
