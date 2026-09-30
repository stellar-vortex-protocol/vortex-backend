import { Dispute, TreasuryRefundRequest } from "./disputes.types";

/** Persistence abstraction for disputes and refunds (in-memory default, Prisma in production). */
export interface IDisputesRepository {
  save(dispute: Dispute): Promise<Dispute>;
  findById(disputeId: string): Promise<Dispute | undefined>;
  findActiveBySlashId(slashId: string): Promise<Dispute | undefined>;
  findAll(): Promise<Dispute[]>;
  saveRefund(refund: TreasuryRefundRequest): Promise<TreasuryRefundRequest>;
  findRefundsBySolver(solver: string): Promise<TreasuryRefundRequest[]>;
}

export class InMemoryDisputesRepository implements IDisputesRepository {
  private readonly disputes = new Map<string, Dispute>();
  private readonly refunds: TreasuryRefundRequest[] = [];

  async save(dispute: Dispute): Promise<Dispute> {
    this.disputes.set(dispute.disputeId, { ...dispute });
    return { ...dispute };
  }

  async findById(disputeId: string): Promise<Dispute | undefined> {
    const dispute = this.disputes.get(disputeId);
    return dispute ? { ...dispute } : undefined;
  }

  async findActiveBySlashId(slashId: string): Promise<Dispute | undefined> {
    for (const dispute of this.disputes.values()) {
      if (dispute.slashId === slashId && (dispute.status === "open" || dispute.status === "under_review")) {
        return { ...dispute };
      }
    }
    return undefined;
  }

  async findAll(): Promise<Dispute[]> {
    return [...this.disputes.values()].map((d) => ({ ...d }));
  }

  async saveRefund(refund: TreasuryRefundRequest): Promise<TreasuryRefundRequest> {
    this.refunds.push({ ...refund });
    return { ...refund };
  }

  async findRefundsBySolver(solver: string): Promise<TreasuryRefundRequest[]> {
    return this.refunds.filter((r) => r.solver === solver).map((r) => ({ ...r }));
  }
}
