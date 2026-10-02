import { inspect } from "node:util";
import { Account, FeeBumpTransaction, Keypair, Networks, Operation, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SignerService } from "./signer.service";
import { SorobanService } from "./soroban.service";
import { ISigner } from "./signers/signer.interface";
import { findSensitiveKeyMaterial } from "./redaction";

/**
 * Build a mock ISigner backed by an optional keypair.
 *
 * SignerService was refactored (issue #400) to delegate to an ISigner backend,
 * so the tests construct it with a mock backend rather than a ConfigService.
 */
function fakeSigner(keypair?: Keypair, network: AppConfig["stellar"]["network"] = "testnet") {
  const passphrase =
    network === "mainnet" ? Networks.PUBLIC : network === "futurenet" ? Networks.FUTURENET : Networks.TESTNET;
  return {
    // Mirrors LocalKeypairSigner: an unconfigured backend has no public key and
    // throws a clear, secret-free error when one is requested.
    publicKey: () => {
      if (!keypair) throw new Error("Signer is not configured: no signing key is available");
      return keypair.publicKey();
    },
    networkPassphrase: () => passphrase,
    signTransaction: async <T extends Transaction | FeeBumpTransaction>(tx: T): Promise<T> => {
      if (keypair) tx.sign(keypair);
      return tx;
    },
    signAuthEntry: async (entry: xdr.SorobanAuthorizationEntry): Promise<xdr.SorobanAuthorizationEntry> => entry,
  } as unknown as ISigner;
}

function fakeSorobanService(startingSequence = "100") {
  return {
    getAccount: jest.fn().mockImplementation(async (publicKey: string) => new Account(publicKey, startingSequence)),
  } as unknown as jest.Mocked<SorobanService>;
}

describe("SignerService", () => {
  it("reports unconfigured when no secret is set", () => {
    const service = new SignerService(fakeSigner(), fakeSorobanService());
    expect(service.isConfigured()).toBe(false);
  });

  it("throws a clear, secret-free error when signing without a configured key", () => {
    const service = new SignerService(fakeSigner(), fakeSorobanService());
    expect(() => service.getPublicKey()).toThrow(/not configured|signing key/i);
    // The message must stay secret-free (no strkey / seed shape).
    let message = "";
    try {
      service.getPublicKey();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toMatch(/^S[A-Z2-7]{55}$/);
  });

  it("derives the public key from the configured secret", () => {
    const keypair = Keypair.random();
    const service = new SignerService(fakeSigner(keypair), fakeSorobanService());

    expect(service.isConfigured()).toBe(true);
    expect(service.getPublicKey()).toBe(keypair.publicKey());
  });

  it("maps network config to the right passphrase", () => {
    const soroban = fakeSorobanService();
    expect(new SignerService(fakeSigner(undefined, "testnet"), soroban).getNetworkPassphrase()).toBe(Networks.TESTNET);
    expect(new SignerService(fakeSigner(undefined, "futurenet"), soroban).getNetworkPassphrase()).toBe(Networks.FUTURENET);
    expect(new SignerService(fakeSigner(undefined, "mainnet"), soroban).getNetworkPassphrase()).toBe(Networks.PUBLIC);
  });

  it("signs a transaction with the configured key", async () => {
    const keypair = Keypair.random();
    const service = new SignerService(fakeSigner(keypair), fakeSorobanService());

    const account = new Account(keypair.publicKey(), "1");
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
      .setTimeout(30)
      .build();

    expect(tx.signatures).toHaveLength(0);
    const signed = await service.sign(tx);
    expect(signed.signatures).toHaveLength(1);
  });

  it("never includes the raw secret in string/JSON/inspect representations", () => {
    const keypair = Keypair.random();
    const service = new SignerService(fakeSigner(keypair), fakeSorobanService());

    const secret = keypair.secret();
    expect(String(service)).not.toContain(secret);
    expect(JSON.stringify(service)).not.toContain(secret);
    expect(inspect(service)).not.toContain(secret);
    expect(findSensitiveKeyMaterial(service)).toEqual([]);
  });

  it("exposes no raw Stellar secret in serialized error payloads", () => {
    const keypair = Keypair.random();
    const secret = keypair.secret();
    const payload = {
      error: "transaction simulation failed",
      signer: { secretKey: secret, publicKey: keypair.publicKey() },
    };

    expect(findSensitiveKeyMaterial(payload)).toContain(secret);
    expect(findSensitiveKeyMaterial({ error: "ok" })).toEqual([]);
  });

  describe("withNextSequence", () => {
    it("fetches the starting sequence once and increments it locally", async () => {
      const keypair = Keypair.random();
      const soroban = fakeSorobanService("100");
      const service = new SignerService(fakeSigner(keypair), soroban);

      const first = await service.withNextSequence(async (sequence) => sequence);
      const second = await service.withNextSequence(async (sequence) => sequence);
      const third = await service.withNextSequence(async (sequence) => sequence);

      expect([first, second, third]).toEqual(["101", "102", "103"]);
      expect(soroban.getAccount).toHaveBeenCalledTimes(1);
    });

    it("hands out a distinct, gap-free sequence to every concurrent caller", async () => {
      const keypair = Keypair.random();
      const soroban = fakeSorobanService("0");
      const service = new SignerService(fakeSigner(keypair), soroban);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.withNextSequence(async (sequence) => sequence)),
      );

      const numeric = results.map(Number).sort((a, b) => a - b);
      expect(new Set(numeric).size).toBe(20); // no two callers got the same sequence
      expect(numeric).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)); // 1..20, no gaps
    });

    it("runs callers strictly one at a time, in call order", async () => {
      const keypair = Keypair.random();
      const service = new SignerService(fakeSigner(keypair), fakeSorobanService("0"));
      const order: number[] = [];

      const slow = service.withNextSequence(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(1);
      });
      const fast = service.withNextSequence(async () => {
        order.push(2);
      });

      await Promise.all([slow, fast]);
      expect(order).toEqual([1, 2]); // fast waited for slow despite finishing faster on its own
    });

    it("drops the cached sequence after a failure so the next call re-syncs from the network", async () => {
      const keypair = Keypair.random();
      const soroban = fakeSorobanService("100");
      const service = new SignerService(fakeSigner(keypair), soroban);

      await expect(
        service.withNextSequence(async () => {
          throw new Error("submission failed");
        }),
      ).rejects.toThrow("submission failed");

      const next = await service.withNextSequence(async (sequence) => sequence);
      expect(next).toBe("101");
      expect(soroban.getAccount).toHaveBeenCalledTimes(2); // re-fetched after the failure
    });

    it("does not let a failed caller block callers queued behind it", async () => {
      const keypair = Keypair.random();
      const service = new SignerService(fakeSigner(keypair), fakeSorobanService("0"));

      const failing = service.withNextSequence(async () => {
        throw new Error("boom");
      });
      const following = service.withNextSequence(async (sequence) => sequence);

      await expect(failing).rejects.toThrow("boom");
      // cache was dropped after the failure, so this re-syncs from the network (still "0") and gets "1"
      await expect(following).resolves.toBe("1");
    });
  });
});
