import { Module } from "@nestjs/common";
import { EvmDepositVerifier } from "./evm-deposit-verifier";
import { SOURCE_CHAIN_VERIFIERS } from "../source-chain-verifier";

/**
 * EVM source-chain support (issue #403). Registers EvmDepositVerifier under
 * the SOURCE_CHAIN_VERIFIERS token consumed by SourceDepositVerificationService.
 */
@Module({
  providers: [
    EvmDepositVerifier,
    { provide: SOURCE_CHAIN_VERIFIERS, inject: [EvmDepositVerifier], useFactory: (evm: EvmDepositVerifier) => [evm] },
  ],
  exports: [SOURCE_CHAIN_VERIFIERS, EvmDepositVerifier],
})
export class EvmModule {}
