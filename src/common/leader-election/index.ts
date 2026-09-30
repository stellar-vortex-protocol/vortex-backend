export { LeaderElectionModule } from "./leader-election.module";
export { LeaderElectionService, DEFAULT_HEARTBEAT_INTERVAL_MS } from "./leader-election.service";
export type { LeadershipCallback } from "./leader-election.service";
export {
  LEADER_ELECTION_BACKEND,
} from "./leader-election.types";
export type { LeaderElectionBackend, LeadershipState } from "./leader-election.types";
export { PostgresAdvisoryLockBackend } from "./postgres-advisory-lock.backend";
export { Singleton, SINGLETON_WORKER_KEY } from "./singleton.decorator";
