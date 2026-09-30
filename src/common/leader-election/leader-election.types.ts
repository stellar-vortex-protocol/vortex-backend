/**
 * Pluggable backend interface for the LeaderElectionService.
 *
 * Each backend implements the acquire / renew / release contract around a
 * named worker lock. The Postgres advisory-lock backend is the default;
 * a K8s Lease backend can be wired in by providing a different class that
 * satisfies this interface.
 *
 * Implementors MUST guarantee:
 *  - acquire() is idempotent — calling it when already leader is safe.
 *  - release() is a no-op when the caller is not the current leader.
 *  - All methods resolve without throwing (errors become false/void returns).
 */
export interface LeaderElectionBackend {
  /**
   * Attempt to acquire the named lock for `workerName`.
   *
   * @returns fencing token (a monotonically increasing integer) when
   *          leadership is acquired, or `null` when another replica holds it.
   */
  tryAcquire(workerName: string): Promise<number | null>;

  /**
   * Renew an existing lock, extending its TTL.
   *
   * @returns `true` when the lock was successfully renewed, `false` when the
   *          lock was lost (e.g. TTL expired and another replica acquired it).
   */
  renew(workerName: string, fencingToken: number): Promise<boolean>;

  /**
   * Release the named lock, allowing another replica to acquire it.
   * A no-op if the caller does not currently hold the lock.
   */
  release(workerName: string, fencingToken: number): Promise<void>;
}

/** Injection token for the pluggable LeaderElectionBackend. */
export const LEADER_ELECTION_BACKEND = Symbol("LEADER_ELECTION_BACKEND");

/**
 * Current leadership state for a single worker.
 */
export interface LeadershipState {
  /** Whether this replica is the current leader. */
  isLeader: boolean;
  /** Fencing token assigned at acquisition time; `null` when not leader. */
  fencingToken: number | null;
  /** ISO timestamp of when leadership was acquired; `null` when not leader. */
  acquiredAt: string | null;
  /** Number of leadership acquisitions over the process lifetime. */
  acquisitionCount: number;
}
