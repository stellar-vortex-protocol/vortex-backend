import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SorobanService } from "./soroban.service";

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
  getAccount(@Param("publicKey") publicKey: string) {
    return this.sorobanService.getAccount(publicKey);
  }
}
