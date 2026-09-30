import { Global, Module } from "@nestjs/common";
import { FeesService } from "./fees.service";

/** Fee quotes and the in-process double-entry ledger (issue #438). */
@Global()
@Module({
  providers: [FeesService],
  exports: [FeesService],
})
export class FeesModule {}
