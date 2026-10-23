import { Injectable, Optional } from '@nestjs/common';

import { EgressPurpose } from './http-egress.service';

/**
 * State of a per-destination circuit breaker.
 *
 * - `closed`: requests flow normally; consecutive failures are counted.
 * - `open`: requests fail fast without touching the network.
 * - `half-open`: a single probe request is allowed through; success closes the
 *   breaker, failure re-opens it.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Error thrown when a request is short-circuited because the breaker for the
 * destination is open. Distinct from network errors so callers can tell the
 * difference between "we tried and failed" and "we did not try".
 */
export class CircuitOpenError extends Error {
  readonly purpose: EgressPurpose;
  readonly hostname: string;
  readonly state: CircuitState;
  readonly lastTransitionAt: number;

  constructor(purpose: EgressPurpose, hostname: string, state: CircuitState, lastTransitionAt: number) {
    super(
      `Circuit breaker is ${state} for ${purpose} destination ${hostname}; request not attempted`,
    );
    this.name = 'CircuitOpenError';
    this.purpose = purpose;
    this.hostname = hostname;
    this.state = state;
    this.lastTransitionAt = lastTransitionAt;
  }
}

/**
 * Snapshot of a single breaker's state, suitable for exposing over an admin
 * health endpoint.
 */
export interface CircuitBreakerSnapshot {
  purpose: EgressPurpose;
  hostname: string;
  state: CircuitState;
  /** Consecutive failures observed while the breaker was closed. */
  failureCount: number;
  /** Consecutive successes observed while the breaker was half-open. */
  successCount: number;
  /** Epoch milliseconds of the last state transition. */
  lastTransitionAt: number;
  /** Epoch milliseconds of the last recorded failure, if any. */
  lastFailureAt: number | null;
  /** Epoch milliseconds of the last recorded success, if any. */
  lastSuccessAt: number | null;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip a closed breaker open. */
  failureThreshold: number;
  /** Consecutive successes required to close a half-open breaker. */
  successThreshold: number;
  /** Milliseconds an open breaker waits before allowing a half-open probe. */
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  successThreshold: 2,
  cooldownMs: 30_000,
};

/**
 * A single per-destination circuit breaker.
 *
 * The breaker is purely in-memory and per-process. Cross-replica sharing of
 * breaker state is intentionally out of scope.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastTransitionAt: number;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;

  constructor(
    readonly purpose: EgressPurpose,
    readonly hostname: string,
    private readonly options: CircuitBreakerOptions,
    private readonly now: () => number,
  ) {
    this.lastTransitionAt = this.now();
  }

  /**
   * Returns the current effective state, lazily transitioning an open breaker
   * to half-open once its cooldown has elapsed.
   */
  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.lastTransitionAt >= this.options.cooldownMs) {
      this.transitionTo('half-open');
    }
    return this.state;
  }

  /**
   * Throws {@link CircuitOpenError} if the breaker currently disallows a
   * request. A half-open breaker allows exactly one probe at a time; callers
   * are expected to report the outcome via {@link recordSuccess} or
   * {@link recordFailure}.
   */
  assertRequestAllowed(): void {
    const state = this.getState();
    if (state === 'open') {
      throw new CircuitOpenError(this.purpose, this.hostname, state, this.lastTransitionAt);
    }
  }

  /** Alias for {@link assertRequestAllowed}. */
  assertClosed(): void {
    this.assertRequestAllowed();
  }

  recordSuccess(): void {
    const now = this.now();
    this.lastSuccessAt = now;

    if (this.state === 'half-open') {
      this.successCount += 1;
      if (this.successCount >= this.options.successThreshold) {
        this.failureCount = 0;
        this.successCount = 0;
        this.transitionTo('closed');
      }
      return;
    }

    // Closed: a success resets the consecutive-failure counter.
    this.failureCount = 0;
    this.successCount = 0;
  }

  recordFailure(): void {
    const now = this.now();
    this.lastFailureAt = now;

    if (this.state === 'half-open') {
      // A failed probe re-opens the breaker and restarts the cooldown.
      this.successCount = 0;
      this.transitionTo('open');
      return;
    }

    this.failureCount += 1;
    if (this.failureCount >= this.options.failureThreshold) {
      this.transitionTo('open');
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      purpose: this.purpose,
      hostname: this.hostname,
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastTransitionAt: this.lastTransitionAt,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  private transitionTo(next: CircuitState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.lastTransitionAt = this.now();
  }
}

/**
 * Registry of circuit breakers keyed by `(purpose, hostname)`.
 *
 * Breakers are created lazily on first use and retained for the lifetime of
 * the process so that failure history survives across requests.
 */
@Injectable()
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly options: CircuitBreakerOptions;
  private readonly now: () => number;

  constructor(
    @Optional() options?: Partial<CircuitBreakerOptions>,
    @Optional() clock?: () => number,
  ) {
    this.options = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...(options ?? {}) };
    this.now = clock ?? (() => Date.now());
  }

  /**
   * Returns (creating if necessary) the breaker for the given destination.
   */
  getBreaker(purpose: EgressPurpose, hostname: string): CircuitBreaker {
    const key = this.keyFor(purpose, hostname);
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(purpose, hostname, this.options, this.now);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  /** Alias for {@link getBreaker}. */
  get(purpose: EgressPurpose, hostname: string): CircuitBreaker {
    return this.getBreaker(purpose, hostname);
  }

  /**
   * Throws {@link CircuitOpenError} if the breaker for the destination is open.
   */
  assertRequestAllowed(purpose: EgressPurpose, hostname: string): void {
    this.getBreaker(purpose, hostname).assertRequestAllowed();
  }

  recordSuccess(purpose: EgressPurpose, hostname: string): void {
    this.getBreaker(purpose, hostname).recordSuccess();
  }

  recordFailure(purpose: EgressPurpose, hostname: string): void {
    this.getBreaker(purpose, hostname).recordFailure();
  }

  /**
   * Snapshot of every tracked breaker, sorted for stable output.
   */
  snapshots(): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.values())
      .map((breaker) => breaker.snapshot())
      .sort((a, b) => {
        if (a.purpose !== b.purpose) {
          return a.purpose < b.purpose ? -1 : 1;
        }
        return a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0;
      });
  }

  /** Alias for {@link snapshots}. */
  snapshot(): CircuitBreakerSnapshot[] {
    return this.snapshots();
  }

  private keyFor(purpose: EgressPurpose, hostname: string): string {
    return `${purpose}::${hostname.toLowerCase()}`;
  }
}