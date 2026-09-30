import { Module } from "@nestjs/common";
import { IntentsModule } from "../intents/intents.module";
import { SolversModule } from "../solvers/solvers.module";
import { DisputesController } from "./disputes.controller";
import { DisputesService } from "./disputes.service";
import { FillVerifierService } from "./fill-verifier.service";
import { ReviewerGuard } from "./reviewer.guard";
import { InMemoryDisputesRepository } from "./disputes.repository";
import { DISPUTES_REPOSITORY, REVIEWER_ADDRESSES } from "./disputes.tokens";

@Module({
  imports: [SolversModule, IntentsModule],
  controllers: [DisputesController],
  providers: [
    // In-memory by default; a Prisma adapter follows the existing repository
    // pattern (see prisma/schema.prisma Dispute / TreasuryRefundRequest).
    { provide: DISPUTES_REPOSITORY, useClass: InMemoryDisputesRepository },
    {
      // Comma-separated Stellar G-addresses of authorised reviewers.
      provide: REVIEWER_ADDRESSES,
      useFactory: () =>
        (process.env.REVIEWER_ADDRESSES ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
    },
    FillVerifierService,
    DisputesService,
    ReviewerGuard,
  ],
  exports: [DisputesService],
})
export class DisputesModule {}
