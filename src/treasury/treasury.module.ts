import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TreasuryService } from "./treasury.service";
import { TreasuryController } from "./treasury.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { SorobanModule } from "../soroban/soroban.module";
import { TREASURY_ALERT_DELIVERY, createAlertDelivery } from "./treasury-alert-delivery";

@Module({
  imports: [PrismaModule, SorobanModule],
  controllers: [TreasuryController],
  providers: [
    TreasuryService,
    {
      provide: TREASURY_ALERT_DELIVERY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createAlertDelivery(config),
    },
  ],
  exports: [TreasuryService],
})
export class TreasuryModule {}
