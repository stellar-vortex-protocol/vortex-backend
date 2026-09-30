/**
 * Typed domain events published by TxConfirmationService (#386).
 * Consumed by IntentsModule to update intent state after on-chain confirmation.
 */
export class TxConfirmed {
  static readonly EVENT = "tx.confirmed" as const;
  constructor(
    public readonly txHash: string,
    public readonly intentId: string | null,
    public readonly ledger: number,
    public readonly latencyMs: number,
  ) {}
}

export class TxFailed {
  static readonly EVENT = "tx.failed" as const;
  constructor(
    public readonly txHash: string,
    public readonly intentId: string | null,
    public readonly errorCode: string,
    public readonly latencyMs: number,
  ) {}
}

export class TxExpired {
  static readonly EVENT = "tx.expired" as const;
  constructor(
    public readonly txHash: string,
    public readonly intentId: string | null,
    public readonly latencyMs: number,
  ) {}
}

export type TxDomainEvent = TxConfirmed | TxFailed | TxExpired;
