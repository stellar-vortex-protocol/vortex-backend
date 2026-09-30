import { Injectable, Logger, Optional } from "@nestjs/common";
import { JobsService } from "../jobs/jobs.service";
import { defineJob } from "../jobs/jobs.types";
import { Intent } from "./intents.types";

export const DEADLINE_QUEUE = "intents-deadlines";

/** Payload for a deadline job. `deadline` is the unix-second instant this job was armed for. */
export interface DeadlineJobData {
  intentId: string;
  deadline: number;
}

/** Fires when an open intent's user deadline is reached. */
export const EXPIRE_INTENT_JOB = defineJob<DeadlineJobData>(DEADLINE_QUEUE, "expire-intent", {
  attempts: 3,
  backoffMs: 250,
});

/** Fires when an accepted intent's fill window is reached. */
export const FILL_WINDOW_EXPIRED_JOB = defineJob<DeadlineJobData>(DEADLINE_QUEUE, "fill-window-expired", {
  attempts: 3,
  backoffMs: 250,
});

/** Milliseconds until `deadlineSec`, never negative. Exported for tests. */
export function delayUntil(deadlineSec: number, nowMs = Date.now()): number {
  return Math.max(0, deadlineSec * 1000 - nowMs);
}

/**
 * Enqueues deadline jobs. There is no cancel API on the queue, so a moved
 * deadline is a new idempotency key (`kind:intentId:deadline`). The previous
 * job still runs and the handler ignores it when the stored deadline differs.
 */
@Injectable()
export class IntentDeadlineScheduler {
  private readonly logger = new Logger(IntentDeadlineScheduler.name);

  constructor(@Optional() private readonly jobs?: JobsService) {}

  /** Arm `expire-intent` for an open intent. */
  scheduleExpire(intent: Pick<Intent, "intentId" | "deadline">): void {
    this.enqueue(EXPIRE_INTENT_JOB, intent);
  }

  /** Arm `fill-window-expired` for an accepted intent (accept or a later amendment). */
  scheduleFillWindow(intent: Pick<Intent, "intentId" | "deadline">): void {
    this.enqueue(FILL_WINDOW_EXPIRED_JOB, intent);
  }

  private enqueue(
    def: typeof EXPIRE_INTENT_JOB | typeof FILL_WINDOW_EXPIRED_JOB,
    intent: Pick<Intent, "intentId" | "deadline">,
  ): void {
    if (!this.jobs) return;
    try {
      this.jobs.defineQueue(DEADLINE_QUEUE, { concurrency: 8 });
      void this.jobs
        .enqueue(
          def,
          { intentId: intent.intentId, deadline: intent.deadline },
          {
            delayMs: delayUntil(intent.deadline),
            idempotencyKey: `${def.name}:${intent.intentId}:${intent.deadline}`,
          },
        )
        .catch((err: unknown) => {
          this.logger.error(
            `[deadlines] failed to enqueue ${def.name} for ${intent.intentId}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        });
    } catch (err) {
      this.logger.error(
        `[deadlines] failed to enqueue ${def.name} for ${intent.intentId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
}
