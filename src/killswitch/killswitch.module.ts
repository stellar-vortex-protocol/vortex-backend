import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { KillSwitchController } from "./killswitch.controller";
import { KillSwitchGuard } from "./killswitch.guard";
import { KillSwitchService } from "./killswitch.service";
import { OperatorGuard } from "./operator.guard";
import {
  KILL_SWITCH_REPOSITORY,
  InMemoryKillSwitchRepository,
} from "./killswitch.repository";
import { PrismaKillSwitchRepository } from "./prisma-killswitch.repository";
import { PrismaService } from "../prisma/prisma.service";
import { IntentsGateway } from "../intents/intents.gateway";
import { IntentsModule } from "../intents/intents.module";

/**
 * Injection token for the post-construction WS binding.
 *
 * Present only so the binding is a real provider Nest will instantiate; the
 * value is a side effect, not something anybody injects.
 */
export const KILL_SWITCH_WS_BINDING = Symbol("KILL_SWITCH_WS_BINDING");

/**
 * Emergency pause control plane (issue #477).
 *
 * Global so `KillSwitchGuard` can gate write handlers in any module without
 * each of them importing this one, and so a single service instance — and its
 * local snapshot — is shared by every guarded route.
 *
 * No cycle exists here: nothing imports KillSwitchModule except AppModule, and
 * a `@Global()` module creates no import edges of its own.
 */
@Global()
@Module({
  imports: [IntentsModule],
  controllers: [KillSwitchController],
  providers: [
    KillSwitchService,
    KillSwitchGuard,
    OperatorGuard,
    {
      // Same adapter-selection convention as intents/solvers/tokens:
      // KILLSWITCH_PERSISTENCE=prisma → Postgres, memory → in-memory.
      provide: KILL_SWITCH_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (_config: ConfigService, prisma: PrismaService) =>
        (process.env.KILLSWITCH_PERSISTENCE ?? "memory") === "prisma"
          ? new PrismaKillSwitchRepository(prisma)
          : new InMemoryKillSwitchRepository(),
    },
    {
      // Bind the WS notifier after construction rather than injecting
      // IntentsGateway into KillSwitchService, which would put IntentsModule
      // on the service's critical path for every write-path evaluation.
      provide: KILL_SWITCH_WS_BINDING,
      inject: [KillSwitchService, IntentsGateway],
      useFactory: (killSwitch: KillSwitchService, gateway: IntentsGateway) => {
        killSwitch.broadcastStatus = (event) => gateway.broadcast(event);
      },
    },
  ],
  exports: [KillSwitchService, KillSwitchGuard, KILL_SWITCH_REPOSITORY],
})
export class KillSwitchModule {}
