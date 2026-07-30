import { inspect } from "node:util";
import { ConfigService } from "@nestjs/config";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SignerService } from "./signer.service";
import { SorobanService } from "./soroban.service";

function configWith(signerSecretKey: string, network: AppConfig["stellar"]["network"] = "testnet") {
  const values: Record<string, unknown> = {
    "stellar.signingKey": signerSecretKey,
    "stellar.network": network,
  };
  return { get: (path: string) => values[path] } as ConfigService<AppConfig, true>;
}

function fakeSorobanService(startingSequence = "100") {
  return {
    getAccount: jest.fn().mockImplementation(async (publicKey: string) => new Account(publicKey, startingSequence)),
  } as unknown as jest.Mocked<SorobanService>;
}

describe("SignerService", () => {
  it("reports unconfigured when no secret is set", () => {
    const service = new SignerService(configWith(""), fakeSorobanService());
    expect(service.isConfigured()).toBe(false);
  });

  it("throws a clear, secret-free error when signing without a configured key", () => {
    const service = new SignerService(configWith(""), fakeSorobanService());
    expect(() => service.getPublicKey()).toThrow(/SOROBAN_SIGNER_SECRET_KEY/);
  });

  it("derives the public key from the configured secret", () => {
    const keypair = Keypair.random();
    const service = new SignerService(configWith(keypair.secret()), fakeSorobanService());

    expect(service.isConfigured()).toBe(true);
    expect(service.getPublicKey()).toBe(keypair.publicKey());
  });

  it("maps network config to the right passphrase", () => {
    const soroban = fakeSorobanService();
    expect(new SignerService(configWith("", "testnet"), soroban).getNetworkPassphrase()).toBe(Networks.TESTNET);
    expect(new SignerService(configWith("", "futurenet"), soroban).getNetworkPassphrase()).toBe(Networks.FUTURENET);
    expect(new SignerService(configWith("", "mainnet"), soroban).getNetworkPassphrase()).toBe(Networks.PUBLIC);
  });

  it("signs a transaction with the configured key", () => {
    const keypair = Keypair.random();
    const service = new SignerService(configWith(keypair.secret()), fakeSorobanService());

    const account = new Account(keypair.publicKey(), "1");
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
      .setTimeout(30)
      .build();

    expect(tx.signatures).toHaveLength(0);
    const signed = service.sign(tx);
    expect(signed.signatures).toHaveLength(1);
  });

  it("never includes the raw secret in string/JSON/inspect representations", () => {
    const keypair = Keypair.random();
    const service = new SignerService(configWith(keypair.secret()), fakeSorobanService());

    const secret = keypair.secret();
    expect(String(service)).not.toContain(secret);
    expect(JSON.stringify(service)).not.toContain(secret);
    expect(inspect(service)).not.toContain(secret);
  });

  describe("withNextSequence", () => {
    it("fetches the starting sequence once and increments it locally", async () => {
      const keypair = Keypair.random();
      const soroban = fakeSorobanService("100");
      const service = new SignerService(configWith(keypair.secret()), soroban);

      const first = await service.withNextSequence(async (sequence) => sequence);
      const second = await service.withNextSequence(async (sequence) => sequence);
      const third = await service.withNextSequence(async (sequence) => sequence);

      expect([first, second, third]).toEqual(["101", "102", "103"]);
      expect(soroban.getAccount).toHaveBeenCalledTimes(1);
    });

    it("hands out a distinct, gap-free sequence to every concurrent caller", async () => {
      const keypair = Keypair.random();
      const soroban = fakeSorobanService("0");
      const service = new SignerService(configWith(keypair.secret()), soroban);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.withNextSequence(async (sequence) => sequence)),
      );

      const numeric = results.map(Number).sort((a, b) => a - b);
      expect(new Set(numeric).size).toBe(20); // no two callers got the same sequence
      expect(numeric).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)); // 1..20, no gaps
    });

    it("runs callers strictly one at a time, in call order", async () => {
      const keypair = Keypair.random();
      const service = new SignerService(configWith(keypair.secret()), fakeSorobanService("0"));
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
      const service = new SignerService(configWith(keypair.secret()), soroban);

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
      const service = new SignerService(configWith(keypair.secret()), fakeSorobanService("0"));

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
