import { Module } from "@nestjs/common";
import { TreasuryService } from "./treasury.service";
import { TreasuryController } from "./treasury.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { SorobanModule } from "../soroban/soroban.module";

@Module({
  imports: [PrismaModule, SorobanModule],
  controllers: [TreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
