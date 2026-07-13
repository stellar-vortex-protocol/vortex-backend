import { Module } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { SolversModule } from "../solvers/solvers.module";

@Module({
  imports: [SolversModule],
  controllers: [IntentsController],
  providers: [IntentsService],
  exports: [IntentsService],
})
export class IntentsModule {}
