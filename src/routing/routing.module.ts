import { Module } from "@nestjs/common";
import { RoutingService } from "./routing.service";
import {
  INTERMEDIATE_TOKEN_CANDIDATES,
  IntermediateTokenCandidatesProvider,
  defaultIntermediateTokenCandidates,
} from "./routing.service";

@Module({
  providers: [
    RoutingService,
    {
      provide: INTERMEDIATE_TOKEN_CANDIDATES,
      useValue: defaultIntermediateTokenCandidates,
    },
  ],
  exports: [RoutingService],
})
export class RoutingModule {}
