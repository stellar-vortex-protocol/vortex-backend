import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { EvmModule } from "./evm.module";
import { EvmDepositVerifier } from "./evm-deposit-verifier";
import { SOURCE_CHAIN_VERIFIERS, SourceChainVerifier } from "../source-chain-verifier";

describe("EvmModule", () => {
  it("registers EvmDepositVerifier as a source-chain verifier", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EvmModule] })
      .useMocker((token) => (token === ConfigService ? { get: () => undefined } : undefined))
      .compile();

    const verifiers = moduleRef.get<SourceChainVerifier[]>(SOURCE_CHAIN_VERIFIERS);
    expect(verifiers).toHaveLength(1);
    expect(verifiers[0]).toBeInstanceOf(EvmDepositVerifier);
  });
});
