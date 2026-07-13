import { Module } from "@nestjs/common";
import { IntentsService } from "./intents.service";

@Module({
  providers: [IntentsService],
  exports: [IntentsService],
})
export class IntentsModule {}
