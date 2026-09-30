import { Module } from "@nestjs/common";
import { TokensModule } from "../tokens/tokens.module";
import { AggregatorService } from "./aggregator.service";

/** Oracle price snapshots used by intent minDstAmount validation (issue #434). */
@Module({
  imports: [TokensModule],
  providers: [AggregatorService],
  exports: [AggregatorService],
})
export class PricingModule {}
