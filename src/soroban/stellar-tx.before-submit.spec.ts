import { ConfigService } from "@nestjs/config";
import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { SignerService } from "./signer.service";
import { SorobanService } from "./soroban.service";
import { INVOKE_TX_TIMEOUT_SECONDS, StellarTxService } from "./stellar-tx.service";
import { TxConfirmationService } from "./tx-confirmation.service";

const CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/**
 * Issue #396 — the outbox relay persists the signed envelope hash through
 * `invokeContract`'s `beforeSubmit` hook, which must run after signing and
 * strictly before broadcast.
 */
describe("StellarTxService.invokeContract beforeSubmit (#396)", () => {
  const signerKeypair = Keypair.random();
  let events: string[];
  let submitTransaction: jest.Mock;
  let service: StellarTxService;

  beforeEach(() => {
    events = [];
    submitTransaction = jest.fn(async (tx: Transaction) => {
      events.push("submit");
      return { status: "PENDING", hash: tx.hash().toString("hex") };
    });
    const soroban = {
      getFeeStats: jest.fn().mockRejectedValue(new Error("no stats")),
      simulateTransaction: jest.fn().mockResolvedValue({ minResourceFee: "0", latestLedger: 1 }),
      prepareTransaction: jest.fn(async (tx: Transaction) => tx),
      submitTransaction,
    };
    const signer = {
      withNextSequence: (fn: (seq: string) => Promise<unknown>) => fn("100"),
      getPublicKey: () => signerKeypair.publicKey(),
      getNetworkPassphrase: () => Networks.TESTNET,
      sign: async (tx: Transaction) => {
        tx.sign(signerKeypair);
        return tx;
      },
    };
    const confirmation = {
      waitForConfirmation: jest.fn(async (hash: string) => ({ hash, status: "SUCCESS", durationMs: 1 })),
    };
    const config = {
      get: (key: string) =>
        ({ onchainDryRun: false, "stellar.network": "testnet", "stellar.feePercentile": "p50" })[key],
    };
    service = new StellarTxService(
      soroban as unknown as SorobanService,
      signer as unknown as SignerService,
      confirmation as unknown as TxConfirmationService,
      config as unknown as ConfigService<AppConfig, true>,
      undefined,
      { evaluateTarget: () => ({ paused: false }) } as unknown as KillSwitchService,
    );
  });

  it("hands the signed envelope hash to beforeSubmit before broadcasting", async () => {
    let hookHash = "";
    const result = await service.invokeContract(
      { contractId: CONTRACT_ID, method: "create_intent", args: [] },
      {
        beforeSubmit: async (hash) => {
          events.push("beforeSubmit");
          hookHash = hash;
        },
      },
    );

    expect(events).toEqual(["beforeSubmit", "submit"]);
    const submitted = submitTransaction.mock.calls[0][0] as Transaction;
    expect(submitted.signatures).toHaveLength(1);
    expect(hookHash).toBe(submitted.hash().toString("hex"));
    expect(result).toMatchObject({ hash: hookHash, status: "SUCCESS", dryRun: false });
    // The envelope's time bound is what makes NOT_FOUND-after-lease conclusive.
    const maxTime = Number(submitted.timeBounds?.maxTime);
    expect(maxTime - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(INVOKE_TX_TIMEOUT_SECONDS);
  });

  it("never broadcasts when beforeSubmit throws", async () => {
    await expect(
      service.invokeContract(
        { contractId: CONTRACT_ID, method: "create_intent", args: [] },
        {
          beforeSubmit: async () => {
            throw new Error("lost lease");
          },
        },
      ),
    ).rejects.toThrow("lost lease");
    expect(submitTransaction).not.toHaveBeenCalled();
  });
});
