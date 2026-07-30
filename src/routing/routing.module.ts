import { Module } from "@nestjs/common";
import { RoutingService } from "./routing.service";

@Module({
  providers: [RoutingService],
  exports: [RoutingService],
})
export class RoutingModule {}
