/** Outcome of a rate-limit consumption attempt. */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** The configured limit for the window. */
  limit: number;
  /** Remaining requests in the current window (0 when denied). */
  remaining: number;
  /** Unix epoch ms at which the window resets (oldest entry expires). */
  resetAt: number;
}

/** The narrow Redis surface the distributed rate limiter needs. */
export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}
