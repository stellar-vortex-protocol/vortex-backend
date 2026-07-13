import { Module } from "@nestjs/common";
import { SolversController } from "./solvers.controller";
import { SolversService } from "./solvers.service";

@Module({
  controllers: [SolversController],
  providers: [SolversService],
  exports: [SolversService],
})
export class SolversModule {}
