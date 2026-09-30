import { Global, Injectable, MiddlewareConsumer, Module, NestMiddleware, NestModule, RequestMethod } from "@nestjs/common";
import { FeatureFlagService } from "./feature-flag.service";
import { FlagsController } from "./flags.controller";

/** Pins flag evaluations to one snapshot for the lifetime of each HTTP request. */
@Injectable()
export class FlagSnapshotMiddleware implements NestMiddleware {
  constructor(private readonly flags: FeatureFlagService) {}

  use(_req: unknown, _res: unknown, next: () => void): void {
    this.flags.runWithSnapshot(next);
  }
}

/** Runtime feature flags (issue #495). Global so on-chain services can evaluate flags. */
@Global()
@Module({
  controllers: [FlagsController],
  providers: [FeatureFlagService, FlagSnapshotMiddleware],
  exports: [FeatureFlagService],
})
export class FlagsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(FlagSnapshotMiddleware).forRoutes({ path: "*path", method: RequestMethod.ALL });
  }
}
