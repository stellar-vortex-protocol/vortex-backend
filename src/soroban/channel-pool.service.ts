import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { SorobanService } from "./soroban.service";

export interface ChannelAccount {
  publicKey: string;
  /** Cached sequence number. Updated after every submission and re-synced on tx_bad_seq. */
  cachedSequence: bigint | null;
  /** Whether this channel is currently leased out. */
  leased: boolean;
  /** Unix epoch ms when the current lease expires (0 = not leased). */
  leaseExpiresAt: number;
}

export interface LeaseHandle {
  publicKey: string;
  keypair: Keypair;
  sequence: string;
  release: (success: boolean) => void;
}

const LEASE_TIMEOUT_MS = 30_000; // 30 s lease timeout

@Injectable()
export class ChannelPoolService implements OnModuleInit {
  private readonly logger = new Logger(ChannelPoolService.name);
  private readonly channels: ChannelAccount[] = [];
  private readonly keypairs = new Map<string, Keypair>(); // publicKey → Keypair
  // FIFO waiting queue: each entry resolves when a channel becomes free
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly soroban: SorobanService,
    private readonly metrics: MetricsService,
    configService: ConfigService<AppConfig, true>,
  ) {
    const secrets = configService
      .get("stellar.channelSecretKeys", { infer: true })
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const secret of secrets) {
      try {
        const kp = Keypair.fromSecret(secret);
        const pubKey = kp.publicKey();
        this.keypairs.set(pubKey, kp);
        this.channels.push({
          publicKey: pubKey,
          cachedSequence: null,
          leased: false,
          leaseExpiresAt: 0,
        });
      } catch (err) {
        this.logger.warn(
          `Skipping invalid channel secret key: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `ChannelPoolService initialised with ${this.channels.length} channel accounts`,
    );
  }

  async onModuleInit(): Promise<void> {
    // Prefetch sequence numbers for all channels in parallel
    await Promise.allSettled(
      this.channels.map(async (ch) => {
        try {
          const acct = await this.soroban.getAccount(ch.publicKey);
          ch.cachedSequence = BigInt(acct.sequenceNumber());
        } catch (err) {
          this.logger.warn(
            `Could not prefetch sequence for channel ${ch.publicKey}: ${(err as Error).message}`,
          );
        }
      }),
    );
    this.updateUtilisationMetric();
  }

  /** Number of configured channel accounts. */
  get size(): number {
    return this.channels.length;
  }

  /** True if the pool has at least one channel account configured. */
  isAvailable(): boolean {
    return this.channels.length > 0;
  }

  /**
   * Lease a channel account from the pool. Waits (FIFO) if all channels are busy.
   *
   * The caller MUST call `handle.release(success)` when done:
   *   release(true)  — tx accepted; sequence cache is valid.
   *   release(false) — tx rejected (e.g. tx_bad_seq); sequence will be re-synced.
   */
  async lease(): Promise<LeaseHandle> {
    const leaseStart = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.evictExpiredLeases();
      const ch = this.channels.find((c) => !c.leased);

      if (ch) {
        ch.leased = true;
        ch.leaseExpiresAt = Date.now() + LEASE_TIMEOUT_MS;

        if (ch.cachedSequence === null) {
          const acct = await this.soroban.getAccount(ch.publicKey);
          ch.cachedSequence = BigInt(acct.sequenceNumber());
        }
        ch.cachedSequence += 1n;
        const sequence = ch.cachedSequence.toString();

        this.updateUtilisationMetric();
        const waitMs = Date.now() - leaseStart;
        this.metrics.channelLeaseWaitTime.observe(waitMs / 1000);

        const kp = this.keypairs.get(ch.publicKey)!;
        const self = this;

        return {
          publicKey: ch.publicKey,
          keypair: kp,
          sequence,
          release(success: boolean): void {
            const target = self.channels.find((c) => c.publicKey === ch.publicKey);
            if (target) {
              target.leased = false;
              target.leaseExpiresAt = 0;
              if (!success) {
                // Sequence is suspect — force re-sync on next use
                target.cachedSequence = null;
                self.metrics.channelBadSeqResyncs.inc();
              }
            }
            self.updateUtilisationMetric();
            // Wake the next waiter in FIFO order
            const next = self.waiters.shift();
            if (next) next();
          },
        };
      }

      // No free channel — join the FIFO wait queue
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /**
   * Force re-sync of a channel's sequence number.
   * Call this on tx_bad_seq to ensure the next lease gets the correct sequence.
   */
  async resyncSequence(publicKey: string): Promise<void> {
    const ch = this.channels.find((c) => c.publicKey === publicKey);
    if (!ch) return;
    try {
      const acct = await this.soroban.getAccount(publicKey);
      ch.cachedSequence = BigInt(acct.sequenceNumber());
      this.metrics.channelBadSeqResyncs.inc();
      this.logger.log(`Re-synced sequence for channel ${publicKey}`);
    } catch (err) {
      this.logger.error(
        `Failed to re-sync sequence for channel ${publicKey}: ${(err as Error).message}`,
      );
    }
  }

  private evictExpiredLeases(): void {
    const now = Date.now();
    for (const ch of this.channels) {
      if (ch.leased && now > ch.leaseExpiresAt) {
        this.logger.warn(`Lease timeout eviction for channel ${ch.publicKey}`);
        ch.leased = false;
        ch.leaseExpiresAt = 0;
        ch.cachedSequence = null; // sequence unknown after timeout — force re-sync
        this.metrics.channelBadSeqResyncs.inc();
      }
    }
  }

  private updateUtilisationMetric(): void {
    const leased = this.channels.filter((c) => c.leased).length;
    this.metrics.channelPoolUtilisation.set(
      this.channels.length > 0 ? leased / this.channels.length : 0,
    );
  }

  toString(): string {
    return `ChannelPoolService(size=${this.size})`;
  }

  toJSON(): unknown {
    return {
      size: this.size,
      channels: this.channels.map((c) => ({
        publicKey: c.publicKey,
        leased: c.leased,
      })),
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
