import { Controller, Get, Param, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { StrKey } from "@stellar/stellar-sdk";
import { SorobanService } from "./soroban.service";
import { AccountRateLimitGuard } from "./account-rate-limit.guard";

@ApiTags("chain")
@Controller("api/v1/chain")
export class SorobanController {
  constructor(private readonly sorobanService: SorobanService) {}

  @Get("health")
  getHealth() {
    return this.sorobanService.getHealth();
  }

  @Get("ledger")
  getLatestLedger() {
    return this.sorobanService.getLatestLedger();
  }

  @Get("network")
  getNetwork() {
    return this.sorobanService.getNetwork();
  }

  @Get("account/:publicKey")
  @UseGuards(AccountRateLimitGuard)
  getAccount(@Param("publicKey") publicKey: string) {
    if (
      !publicKey ||
      typeof publicKey !== "string" ||
      !(StrKey?.isValidEd25519PublicKey ? StrKey.isValidEd25519PublicKey(publicKey) : /^G[A-Z2-7]{55}$/.test(publicKey))
    ) {
      throw new BadRequestException("Invalid Stellar public key format");
    }
    return this.sorobanService.getAccount(publicKey);
  }
}

