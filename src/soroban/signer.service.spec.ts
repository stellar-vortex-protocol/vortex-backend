import { inspect } from "node:util";
import { ConfigService } from "@nestjs/config";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SignerService } from "./signer.service";

function configWith(signerSecretKey: string, network: AppConfig["stellar"]["network"] = "testnet") {
  const values: Record<string, unknown> = {
    "stellar.signerSecretKey": signerSecretKey,
    "stellar.network": network,
  };
  return { get: (path: string) => values[path] } as ConfigService<AppConfig, true>;
}

describe("SignerService", () => {
  it("reports unconfigured when no secret is set", () => {
    const service = new SignerService(configWith(""));
    expect(service.isConfigured()).toBe(false);
  });

  it("throws a clear, secret-free error when signing without a configured key", () => {
    const service = new SignerService(configWith(""));
    expect(() => service.getPublicKey()).toThrow(/SOROBAN_SIGNER_SECRET_KEY/);
  });

  it("derives the public key from the configured secret", () => {
    const keypair = Keypair.random();
    const service = new SignerService(configWith(keypair.secret()));

    expect(service.isConfigured()).toBe(true);
    expect(service.getPublicKey()).toBe(keypair.publicKey());
  });

  it("maps network config to the right passphrase", () => {
    expect(new SignerService(configWith("", "testnet")).getNetworkPassphrase()).toBe(Networks.TESTNET);
    expect(new SignerService(configWith("", "futurenet")).getNetworkPassphrase()).toBe(Networks.FUTURENET);
    expect(new SignerService(configWith("", "mainnet")).getNetworkPassphrase()).toBe(Networks.PUBLIC);
  });

  it("signs a transaction with the configured key", () => {
    const keypair = Keypair.random();
    const service = new SignerService(configWith(keypair.secret()));

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
    const service = new SignerService(configWith(keypair.secret()));

    const secret = keypair.secret();
    expect(String(service)).not.toContain(secret);
    expect(JSON.stringify(service)).not.toContain(secret);
    expect(inspect(service)).not.toContain(secret);
  });
});
