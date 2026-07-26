import { Keypair, Networks, SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import { SignerService } from "./signer.service";
import { SorobanService } from "./soroban.service";
import { SorobanSubmissionError, StellarTxService, nativeArgs } from "./stellar-tx.service";

const CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const FAST_OPTS = { baseBackoffMs: 1, maxBackoffMs: 1, pollIntervalMs: 1, pollTimeoutMs: 20 };

function fakeSigner(keypair = Keypair.random()) {
  return {
    getPublicKey: jest.fn(() => keypair.publicKey()),
    getNetworkPassphrase: jest.fn(() => Networks.TESTNET),
    sign: jest.fn((tx: Transaction) => tx),
    withNextSequence: jest.fn(async (fn: (sequence: string) => Promise<unknown>) => fn("101")),
  } as unknown as jest.Mocked<SignerService>;
}

function fakeSoroban() {
  return {
    prepareTransaction: jest.fn(async (tx: Transaction) => tx),
    sendTransaction: jest.fn(),
    getTransactionStatus: jest.fn(),
  } as unknown as jest.Mocked<SorobanService>;
}

function successResponse(): SorobanRpc.Api.GetSuccessfulTransactionResponse {
  return {
    status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    latestLedger: 1,
    latestLedgerCloseTime: 1,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1,
    ledger: 1,
    createdAt: 1,
    applicationOrder: 1,
    feeBump: false,
  } as SorobanRpc.Api.GetSuccessfulTransactionResponse;
}

function failedResponse(): SorobanRpc.Api.GetFailedTransactionResponse {
  return { ...successResponse(), status: SorobanRpc.Api.GetTransactionStatus.FAILED } as SorobanRpc.Api.GetFailedTransactionResponse;
}

function notFoundResponse(): SorobanRpc.Api.GetMissingTransactionResponse {
  return {
    status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
    latestLedger: 1,
    latestLedgerCloseTime: 1,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1,
  };
}

describe("StellarTxService", () => {
  describe("buildContractInvocation", () => {
    it("builds a transaction sourced from the signer's account at the given sequence", async () => {
      const keypair = Keypair.random();
      const signer = fakeSigner(keypair);
      const service = new StellarTxService(fakeSoroban(), signer);

      const tx = await service.buildContractInvocation({
        contractId: CONTRACT_ID,
        method: "create_intent",
        args: nativeArgs("intent-1"),
        sequence: "101",
      });

      expect(tx.source).toBe(keypair.publicKey());
      expect(tx.sequence).toBe("101"); // not "102" -- Account must be built one behind the target
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].type).toBe("invokeHostFunction");
    });
  });

  describe("signAndSubmit", () => {
    it("resolves once the transaction is confirmed on the first attempt", async () => {
      const soroban = fakeSoroban();
      soroban.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc", latestLedger: 1, latestLedgerCloseTime: 1 });
      soroban.getTransactionStatus.mockResolvedValue(successResponse());

      const service = new StellarTxService(soroban, fakeSigner());
      const tx = await service.buildContractInvocation({ contractId: CONTRACT_ID, method: "ping", sequence: "101" });

      const result = await service.signAndSubmit(tx, FAST_OPTS);

      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.SUCCESS);
      expect(soroban.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("checks tx status before resubmitting after a transient failure, instead of blindly resending", async () => {
      const soroban = fakeSoroban();
      soroban.sendTransaction
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce({ status: "PENDING", hash: "abc", latestLedger: 1, latestLedgerCloseTime: 1 });
      soroban.getTransactionStatus
        .mockResolvedValueOnce(notFoundResponse()) // idempotency check before 2nd send: not landed yet
        .mockResolvedValueOnce(successResponse()); // poll after 2nd send

      const service = new StellarTxService(soroban, fakeSigner());
      const tx = await service.buildContractInvocation({ contractId: CONTRACT_ID, method: "ping", sequence: "101" });

      const result = await service.signAndSubmit(tx, FAST_OPTS);

      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.SUCCESS);
      expect(soroban.sendTransaction).toHaveBeenCalledTimes(2);
      expect(soroban.getTransactionStatus).toHaveBeenCalledTimes(2);
    });

    it("does not resend when the idempotency check finds the tx already landed", async () => {
      const soroban = fakeSoroban();
      soroban.sendTransaction.mockRejectedValueOnce(new Error("timed out, unknown outcome"));
      soroban.getTransactionStatus.mockResolvedValueOnce(successResponse()); // already landed from the "failed" attempt

      const service = new StellarTxService(soroban, fakeSigner());
      const tx = await service.buildContractInvocation({ contractId: CONTRACT_ID, method: "ping", sequence: "101" });

      const result = await service.signAndSubmit(tx, FAST_OPTS);

      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.SUCCESS);
      expect(soroban.sendTransaction).toHaveBeenCalledTimes(1); // never resent
    });

    it("caps retry attempts and throws a clear error after exhaustion", async () => {
      const soroban = fakeSoroban();
      soroban.sendTransaction.mockRejectedValue(new Error("TRY_AGAIN_LATER"));
      soroban.getTransactionStatus.mockResolvedValue(notFoundResponse());

      const service = new StellarTxService(soroban, fakeSigner());
      const tx = await service.buildContractInvocation({ contractId: CONTRACT_ID, method: "ping", sequence: "101" });

      await expect(service.signAndSubmit(tx, { ...FAST_OPTS, maxAttempts: 3 })).rejects.toMatchObject({
        name: "SorobanSubmissionError",
        attempts: 3,
      });
      expect(soroban.sendTransaction).toHaveBeenCalledTimes(3);
    });

    it("throws immediately on a confirmed on-chain FAILED status, without burning the retry budget", async () => {
      const soroban = fakeSoroban();
      soroban.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc", latestLedger: 1, latestLedgerCloseTime: 1 });
      soroban.getTransactionStatus.mockResolvedValue(failedResponse());

      const service = new StellarTxService(soroban, fakeSigner());
      const tx = await service.buildContractInvocation({ contractId: CONTRACT_ID, method: "ping", sequence: "101" });

      await expect(service.signAndSubmit(tx, { ...FAST_OPTS, maxAttempts: 5 })).rejects.toMatchObject({
        name: "SorobanSubmissionError",
        terminal: true,
      });
      expect(soroban.sendTransaction).toHaveBeenCalledTimes(1); // FAILED is terminal, not retried
    });

    it("times out waiting for confirmation if it never resolves out of NOT_FOUND", async () => {
      const soroban = fakeSoroban();
      soroban.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc", latestLedger: 1, latestLedgerCloseTime: 1 });
      soroban.getTransactionStatus.mockResolvedValue(notFoundResponse());

      const service = new StellarTxService(soroban, fakeSigner());
      const tx = await service.buildContractInvocation({ contractId: CONTRACT_ID, method: "ping", sequence: "101" });

      await expect(service.signAndSubmit(tx, { ...FAST_OPTS, maxAttempts: 1 })).rejects.toThrow(SorobanSubmissionError);
    });
  });

  describe("invokeContract", () => {
    it("reserves a sequence, builds, and submits under the signer's lock", async () => {
      const soroban = fakeSoroban();
      soroban.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc", latestLedger: 1, latestLedgerCloseTime: 1 });
      soroban.getTransactionStatus.mockResolvedValue(successResponse());
      const signer = fakeSigner();

      const service = new StellarTxService(soroban, signer);
      const result = await service.invokeContract(
        { contractId: CONTRACT_ID, method: "create_intent", args: nativeArgs("intent-1") },
        FAST_OPTS,
      );

      expect(signer.withNextSequence).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.SUCCESS);
    });
  });
});
