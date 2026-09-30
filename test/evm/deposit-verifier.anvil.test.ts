/**
 * Anvil integration test for EVM source-deposit verification (issue #403).
 *
 * Spawns a real Anvil node, deploys test/evm/fixtures/MockEscrow.sol, and
 * drives deposit → confirmation depth → verify → reorg → un-verify through the
 * real EvmDepositVerifier and SourceDepositVerificationService.
 *
 * Requires the `anvil` binary (Foundry). CI installs it with
 * foundry-rs/foundry-toolchain; locally set ANVIL_PATH or put anvil on PATH.
 * The suite is skipped when anvil is unavailable.
 */
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { ConfigService } from "@nestjs/config";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import escrowArtifact from "./fixtures/MockEscrow.json";
import { EvmDepositVerifier } from "../../src/chains/evm/evm-deposit-verifier";
import { intentIdToBytes32 } from "../../src/chains/evm/evm-chains";
import { AppConfig } from "../../src/config/configuration";
import { InMemoryIntentsRepository } from "../../src/intents/intents.repository";
import { IntentsService } from "../../src/intents/intents.service";
import { IntentsGateway } from "../../src/intents/intents.gateway";
import { SourceDepositVerificationService, SRC_REVERIFY_INTERVAL_MS } from "../../src/intents/source-deposit-verification.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import { StellarTxService } from "../../src/soroban/stellar-tx.service";
import { ProtocolParamsService } from "../../src/governance/params.service";

const ANVIL = process.env.ANVIL_PATH ?? "anvil";
const anvilAvailable = spawnSync(ANVIL, ["--version"], { stdio: "ignore" }).status === 0;
const describeAnvil = anvilAvailable ? describe : describe.skip;

// Anvil's first default dev account — publicly known test key, never funded elsewhere.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USER = "GANVILINTEGRATIONUSER";
const PORT = 18545 + (process.pid % 1000);
const RPC_URL = `http://127.0.0.1:${PORT}`;

describeAnvil("EVM deposit verification against Anvil (issue #403)", () => {
  let anvil: ChildProcess;
  let publicClient: PublicClient;
  let escrow: `0x${string}`;
  const account = privateKeyToAccount(DEV_KEY);
  const wallet = createWalletClient({ account, chain: foundry, transport: http(RPC_URL) });
  const testClient = createTestClient({ mode: "anvil", chain: foundry, transport: http(RPC_URL) });

  beforeAll(async () => {
    anvil = spawn(ANVIL, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    // cacheTime 0: the test mines blocks and checks immediately; viem would
    // otherwise serve a block number cached for up to 4 s.
    publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL), cacheTime: 0 }) as PublicClient;
    for (let i = 0; i < 100; i++) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const hash = await wallet.deployContract({
      abi: escrowArtifact.abi,
      bytecode: escrowArtifact.bytecode as `0x${string}`,
    });
    escrow = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  function verifier(): EvmDepositVerifier {
    const config = {
      get: () => ({
        depositVerificationEnabled: true,
        rpcUrls: { ethereum: RPC_URL },
        escrowAddresses: { ethereum: escrow },
        transferFeeToleranceBps: 0,
        logLookbackBlocks: 10_000,
      }),
    } as unknown as ConfigService<AppConfig, true>;
    return new EvmDepositVerifier(config, () => publicClient);
  }

  async function deposit(intentId: string, amount = 1_000_000n, user = USER): Promise<`0x${string}`> {
    const hash = await wallet.writeContract({
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "deposit",
      args: [intentIdToBytes32(intentId), TOKEN, amount, user],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  function harness() {
    const configValues = { evm: { depositVerificationEnabled: true } } as Record<string, unknown>;
    const config = { get: (k: string) => configValues[k] } as unknown as ConfigService<AppConfig, true>;
    const intents = new IntentsService(
      new InMemoryIntentsRepository({ seed: false }),
      config,
      {} as StellarTxService,
      { intentAuditLog: { create: jest.fn().mockResolvedValue({}) } } as unknown as PrismaService,
      undefined, // shadow monitor
      undefined, // metrics
      { snapshotForChain: () => ({ version: 0, deadlineSeconds: 1800, fillWindowSeconds: 600 }) } as unknown as ProtocolParamsService,
    );
    const gateway = { broadcast: jest.fn().mockResolvedValue(undefined) };
    const service = new SourceDepositVerificationService(
      intents,
      gateway as unknown as IntentsGateway,
      config,
      [verifier()],
    );
    return { intents, service, gateway };
  }

  function createIntent(intents: IntentsService, srcTxHash?: string) {
    return intents.create({
      user: USER,
      srcChain: "ethereum",
      srcToken: { address: TOKEN, symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      ...(srcTxHash ? { srcTxHash } : {}),
    });
  }

  it("verifies only once the deposit reaches ethereum's 12-block depth", async () => {
    const { intents, service } = harness();
    const intent = await createIntent(intents);

    expect(await verifier().verify(intent)).toMatchObject({ status: "not_found" });

    await deposit(intent.intentId);
    let now = Date.now();
    await service.tick(now);
    expect(await intents.get(intent.intentId)).toMatchObject({
      srcVerified: false,
      srcVerification: { status: "pending", detail: "1/12 confirmations" },
    });

    await testClient.mine({ blocks: 11 });
    now += 60 * 60_000; // past any retry backoff
    await service.tick(now);
    expect(await intents.get(intent.intentId)).toMatchObject({
      srcVerified: true,
      srcVerification: { status: "verified", detail: "12/12 confirmations", receivedAmount: "1000000" },
    });
  });

  it("verifies from srcTxHash via the receipt", async () => {
    const { intents } = harness();
    const probe = await createIntent(intents);
    const txHash = await deposit(probe.intentId);
    await testClient.mine({ blocks: 12 });

    const withTx = { ...probe, srcTxHash: txHash };
    expect(await verifier().verify(withTx)).toMatchObject({ status: "verified" });
  });

  it("rejects deposits whose amount or user does not match", async () => {
    const { intents } = harness();
    const short = await createIntent(intents);
    const wrongUser = await createIntent(intents);
    await deposit(short.intentId, 999_999n);
    await deposit(wrongUser.intentId, 1_000_000n, "GSOMEBODYELSE");
    await testClient.mine({ blocks: 12 });

    expect(await verifier().verify(short)).toMatchObject({ status: "mismatch", receivedAmount: "999999" });
    expect(await verifier().verify(wrongUser)).toMatchObject({ status: "mismatch", detail: expect.stringMatching(/user/) });
  });

  it("un-verifies an intent when a reorg removes its deposit", async () => {
    const { intents, service, gateway } = harness();
    const intent = await createIntent(intents);

    const snapshot = await testClient.snapshot();
    await deposit(intent.intentId);
    await testClient.mine({ blocks: 12 });
    const now = Date.now();
    await service.tick(now);
    expect(await intents.get(intent.intentId)).toMatchObject({ srcVerified: true });

    // Reorg: roll the chain back past the deposit and build a longer, empty fork.
    await testClient.revert({ id: snapshot });
    await testClient.mine({ blocks: 20 });

    await service.tick(now + SRC_REVERIFY_INTERVAL_MS);
    expect(await intents.get(intent.intentId)).toMatchObject({
      srcVerified: false,
      srcVerification: { status: "reorged" },
    });
    expect(gateway.broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "intent_src_unverified", intentId: intent.intentId, reason: "reorged" }),
    );
  });

  it("drops back to pending when a reorg re-includes the deposit below the confirmation depth", async () => {
    const { intents, service } = harness();
    const intent = await createIntent(intents);

    const snapshot = await testClient.snapshot();
    await deposit(intent.intentId);
    await testClient.mine({ blocks: 12 });
    const now = Date.now();
    await service.tick(now);
    expect(await intents.get(intent.intentId)).toMatchObject({ srcVerified: true });

    // The fork re-mines the same deposit, but only 3 blocks deep.
    await testClient.revert({ id: snapshot });
    await deposit(intent.intentId);
    await testClient.mine({ blocks: 2 });

    await service.tick(now + SRC_REVERIFY_INTERVAL_MS);
    expect(await intents.get(intent.intentId)).toMatchObject({
      srcVerified: false,
      srcVerification: { status: "pending", detail: "3/12 confirmations" },
    });
  });
});
