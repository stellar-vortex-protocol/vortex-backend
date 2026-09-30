import { Backplane, BackplaneHandler, BackplaneHealth, UnsequencedEvent } from "./backplane.types";

/** Single-replica backplane: a local counter and direct delivery (the pre-#454 behaviour). */
export class MemoryBackplane implements Backplane {
  readonly mode = "memory" as const;
  private handler: BackplaneHandler | null = null;
  private seq = 0;

  async start(handler: BackplaneHandler): Promise<void> {
    this.handler = handler;
  }

  async publish(event: UnsequencedEvent): Promise<void> {
    const seq = ++this.seq;
    await this.handler?.({ ...event, seq });
  }

  health(): BackplaneHealth {
    return { mode: this.mode, status: "ok", lastSeq: this.seq, pendingPublishes: 0 };
  }

  async close(): Promise<void> {
    this.handler = null;
  }
}
