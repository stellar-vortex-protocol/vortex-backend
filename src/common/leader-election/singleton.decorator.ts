import { SetMetadata } from "@nestjs/common";

/**
 * Metadata key used by the @Singleton decorator.
 * Can be read at runtime to discover which workers are singleton-guarded.
 */
export const SINGLETON_WORKER_KEY = "singleton_worker_name";

/**
 * Marks a NestJS service as a singleton worker that should run on exactly
 * one replica at a time, controlled by LeaderElectionService.
 *
 * This is a documentation/metadata decorator — it does not auto-wire
 * leader election. The service must still inject LeaderElectionService
 * and call `registerWorker()` in `onModuleInit`.
 *
 * ```ts
 * @Singleton('sweeper')
 * @Injectable()
 * export class IntentsSweeperService implements OnModuleInit {
 *   constructor(private readonly election: LeaderElectionService) {}
 *
 *   onModuleInit() {
 *     this.election.registerWorker('sweeper', (isLeader, token) => {
 *       if (isLeader) this.startInterval();
 *       else          this.stopInterval();
 *     });
 *   }
 * }
 * ```
 *
 * @param workerName  Stable unique name for this worker (kebab-case recommended).
 */
export const Singleton = (workerName: string) => SetMetadata(SINGLETON_WORKER_KEY, workerName);
