import { ConfigService } from "@nestjs/config";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  CONTRACT_VERSION_MAX_AGE_MS,
  ContractVersionService,
  ContractVersionUnsupportedException,
  STELLAR_ASSET_CONTRACT,
} from "./contract-version.service";
import { SorobanService } from "./soroban.service";
import { SupportedContractVersions } from "./contracts/contract-versions";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { PrismaService } from "../prisma/prisma.service";

const SETTLEMENT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const REGISTRY_ID = StrKey.encodeContract(Buffer.alloc(32, 2));
const HASH_V1 = "a1".repeat(32);
const HASH_V2 = "b2".repeat(32);
const HASH_UNKNOWN = "ff".repeat(32);

const REGISTRY: SupportedContractVersions = {
  settlement: { [HASH_V1]: "settlement-v1", [HASH_V2]: "settlement-v1" },
  solverRegistry: { [HASH_V1]: "solver-registry-v1" },
};

/** A real contract-instance ledger entry, as returned by getLedgerEntries. */
function instanceEntry(contractId: string, executable: xdr.ContractExecutable) {
  const data = new xdr.ContractDataEntry({
    // The typings omit the union constructor's switch argument.
    ext: new (xdr.ExtensionPoint as unknown as new (v: number) => xdr.ExtensionPoint)(0),
    contract: new Address(contractId).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
  });
  return { key: {} as xdr.LedgerKey, val: xdr.LedgerEntryData.contractData(data) };
}

const wasm = (hex: string) => xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hex, "hex"));

interface Harness {
  service: ContractVersionService;
  hashes: Record<string, string | Error | "sac">;
  getLedgerEntries: jest.Mock;
  metrics: { setContractVersionSupported: jest.Mock; recordContractUpgrade: jest.Mock; recordContractWriteBlocked: jest.Mock };
  upgradesCreate: jest.Mock;
}

function build(ids: { settlement?: string; solverRegistry?: string } = { settlement: SETTLEMENT_ID, solverRegistry: REGISTRY_ID }): Harness {
  const hashes: Harness["hashes"] = { [SETTLEMENT_ID]: HASH_V1, [REGISTRY_ID]: HASH_V1 };

  const getLedgerEntries = jest.fn(async (key: xdr.LedgerKey) => {
    const contractId = Address.fromScAddress(key.contractData().contract()).toString();
    const current = hashes[contractId];
    if (current instanceof Error) throw current;
    if (current === undefined) return { entries: [], latestLedger: 1 };
    const exec = current === "sac" ? xdr.ContractExecutable.contractExecutableStellarAsset() : wasm(current);
    return { entries: [instanceEntry(contractId, exec)], latestLedger: 1 };
  });

  const config = {
    get: (key: string) =>
      key === "stellar.settlementContractId" ? ids.settlement ?? "" : key === "stellar.solverRegistryContractId" ? ids.solverRegistry ?? "" : undefined,
  } as unknown as ConfigService<AppConfig, true>;
  const metrics = {
    setContractVersionSupported: jest.fn(),
    recordContractUpgrade: jest.fn(),
    recordContractWriteBlocked: jest.fn(),
  };
  const upgradesCreate = jest.fn().mockResolvedValue({});

  const service = new ContractVersionService(
    { getLedgerEntries } as unknown as SorobanService,
    config,
    REGISTRY,
    { contractUpgrade: { create: upgradesCreate } } as unknown as PrismaService,
    metrics as unknown as MetricsService,
  );
  return { service, hashes, getLedgerEntries, metrics, upgradesCreate };
}

describe("ContractVersionService (issue #402)", () => {
  let now: number;
  let h: Harness;

  beforeEach(() => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    h = build();
  });

  afterEach(() => {
    h.service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it("reads the WASM hash from the contract instance and allows writes on a supported ABI", async () => {
    await h.service.onModuleInit();

    const snap = h.service.snapshot();
    expect(snap.readOnly).toBe(false);
    expect(snap.contracts.settlement).toMatchObject({ status: "supported", wasmHash: HASH_V1, abiVersion: "settlement-v1" });
    expect(await h.service.assertWritable("settlement")).toEqual({ abiVersion: "settlement-v1", wasmHash: HASH_V1 });
    expect(h.metrics.setContractVersionSupported).toHaveBeenCalledWith("settlement", true);
  });

  it("enters read-only mode for an unknown hash and blocks writes with a 503", async () => {
    h.hashes[SETTLEMENT_ID] = HASH_UNKNOWN;
    await h.service.onModuleInit();

    expect(h.service.snapshot()).toMatchObject({
      readOnly: true,
      contracts: { settlement: { status: "unknown_hash", wasmHash: HASH_UNKNOWN } },
    });
    await expect(h.service.assertWritable("settlement")).rejects.toBeInstanceOf(ContractVersionUnsupportedException);
    expect(h.metrics.recordContractWriteBlocked).toHaveBeenCalledWith("settlement");
    expect(h.metrics.setContractVersionSupported).toHaveBeenCalledWith("settlement", false);
  });

  it("blocks writes once the mocked hash switches mid-run, detected by the >60 s preflight", async () => {
    await h.service.onModuleInit();
    await expect(h.service.assertWritable("settlement")).resolves.toBeDefined();

    h.hashes[SETTLEMENT_ID] = HASH_UNKNOWN; // contract upgraded on-chain

    // Within the freshness window the cached (supported) hash is used — no RPC.
    now += CONTRACT_VERSION_MAX_AGE_MS - 1;
    const callsBefore = h.getLedgerEntries.mock.calls.length;
    await expect(h.service.assertWritable("settlement")).resolves.toBeDefined();
    expect(h.getLedgerEntries.mock.calls.length).toBe(callsBefore);

    // Past it, the preflight re-reads the hash before allowing the write.
    now += 2;
    await expect(h.service.assertWritable("settlement")).rejects.toBeInstanceOf(ContractVersionUnsupportedException);

    expect(h.service.snapshot().contracts.settlement).toMatchObject({
      status: "unknown_hash",
      wasmHash: HASH_UNKNOWN,
      previousWasmHash: HASH_V1,
    });
    expect(h.metrics.recordContractUpgrade).toHaveBeenCalledWith("settlement", "poll");
    expect(h.upgradesCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contractName: "settlement",
        contractId: SETTLEMENT_ID,
        previousWasmHash: HASH_V1,
        wasmHash: HASH_UNKNOWN,
        abiVersion: null,
        source: "poll",
      }),
    });
  });

  it("keeps writing across an upgrade to another supported hash, recording the history", async () => {
    await h.service.onModuleInit();
    h.hashes[SETTLEMENT_ID] = HASH_V2;
    now += CONTRACT_VERSION_MAX_AGE_MS + 1;

    await expect(h.service.assertWritable("settlement")).resolves.toEqual({ abiVersion: "settlement-v1", wasmHash: HASH_V2 });
    expect(h.upgradesCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ previousWasmHash: HASH_V1, wasmHash: HASH_V2, abiVersion: "settlement-v1" }),
    });
  });

  it("re-enables writes when the contract returns to a supported hash", async () => {
    h.hashes[SETTLEMENT_ID] = HASH_UNKNOWN;
    await h.service.onModuleInit();
    h.hashes[SETTLEMENT_ID] = HASH_V1;
    now += CONTRACT_VERSION_MAX_AGE_MS + 1;

    await expect(h.service.assertWritable("settlement")).resolves.toBeDefined();
    expect(h.service.snapshot().readOnly).toBe(false);
  });

  it("fails closed as `unreachable` when the instance cannot be read", async () => {
    h.hashes[SETTLEMENT_ID] = new Error("rpc timeout");
    h.hashes[REGISTRY_ID] = undefined as unknown as string; // not deployed
    await h.service.onModuleInit();

    const { contracts, readOnly } = h.service.snapshot();
    expect(readOnly).toBe(true);
    expect(contracts.settlement).toMatchObject({ status: "unreachable", error: "rpc timeout" });
    expect(contracts.solverRegistry).toMatchObject({ status: "unreachable", error: expect.stringMatching(/not found/) });
    await expect(h.service.assertWritable("solverRegistry")).rejects.toBeInstanceOf(ContractVersionUnsupportedException);
  });

  it("reports Stellar Asset Contracts (no WASM) as unknown", async () => {
    h.hashes[SETTLEMENT_ID] = "sac";
    await h.service.onModuleInit();
    expect(h.service.snapshot().contracts.settlement).toMatchObject({ status: "unknown_hash", wasmHash: STELLAR_ASSET_CONTRACT });
  });

  it("treats unconfigured contracts as not read-only but still refuses writes to them", async () => {
    h = build({ settlement: SETTLEMENT_ID });
    await h.service.onModuleInit();

    const { contracts, readOnly } = h.service.snapshot();
    expect(readOnly).toBe(false);
    expect(contracts.solverRegistry.status).toBe("unconfigured");
    await expect(h.service.assertWritable("solverRegistry")).rejects.toBeInstanceOf(ContractVersionUnsupportedException);
    expect(h.getLedgerEntries).toHaveBeenCalledTimes(1); // only the configured contract is polled
  });

  it("shares one RPC call between concurrent refreshes", async () => {
    await Promise.all([h.service.refresh("settlement"), h.service.refresh("settlement"), h.service.refresh("settlement")]);
    expect(h.getLedgerEntries).toHaveBeenCalledTimes(1);
  });

  it("records an ingested upgrade event and re-checks the hash immediately", async () => {
    await h.service.onModuleInit();
    h.hashes[REGISTRY_ID] = HASH_UNKNOWN;

    await h.service.recordUpgradeEvent({ contractId: REGISTRY_ID, ledger: 4242, txHash: "abc" });

    expect(h.service.snapshot().contracts.solverRegistry.status).toBe("unknown_hash");
    expect(h.upgradesCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ contractName: "solverRegistry", source: "poll", wasmHash: HASH_UNKNOWN }),
    });
  });

  it("records the event itself when the poll had already seen the new hash", async () => {
    await h.service.onModuleInit();
    await h.service.recordUpgradeEvent({ contractId: SETTLEMENT_ID, ledger: 7, txHash: "t", wasmHash: HASH_V1 });

    expect(h.metrics.recordContractUpgrade).toHaveBeenCalledWith("settlement", "event");
    expect(h.upgradesCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: "event", ledger: 7, txHash: "t", wasmHash: HASH_V1 }),
    });
  });

  it("ignores upgrade events from contracts it does not track", async () => {
    await h.service.onModuleInit();
    await h.service.recordUpgradeEvent({ contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()), ledger: 1 });
    expect(h.upgradesCreate).not.toHaveBeenCalled();
  });

  it("never lets a failed history write break version tracking", async () => {
    h.upgradesCreate.mockRejectedValue(new Error("db down"));
    await h.service.onModuleInit();
    h.hashes[SETTLEMENT_ID] = HASH_V2;
    now += CONTRACT_VERSION_MAX_AGE_MS + 1;
    await expect(h.service.assertWritable("settlement")).resolves.toBeDefined();
  });
});
