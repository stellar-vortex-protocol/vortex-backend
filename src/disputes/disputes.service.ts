import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { SolversService } from "../solvers/solvers.service";
import { FillVerifierService } from "./fill-verifier.service";
import { DISPUTES_REPOSITORY } from "./disputes.tokens";
import { IDisputesRepository } from "./disputes.repository";
import {
  Dispute,
  DisputeEvidence,
  DisputeResolution,
  DisputeStatistics,
  DISPUTE_SLA_SECONDS,
  DISPUTE_WINDOW_SECONDS,
  TreasuryRefundRequest,
} from "./disputes.types";

export interface SubmitDisputeInput {
  slashId: string;
  reason: string;
  evidence: DisputeEvidence;
}

/**
 * Slash-dispute lifecycle: submit (authenticated) → review → decide.
 *
 * Invariants:
 *   - one active dispute per slash;
 *   - disputes must be filed within DISPUTE_WINDOW_SECONDS of the slash;
 *   - a decision requires a reviewer (enforced by ReviewerGuard) and a reason;
 *   - once decided, a dispute is immutable (no further transitions).
 */
@Injectable()
export class DisputesService {
  constructor(
    @Inject(DISPUTES_REPOSITORY) private readonly repo: IDisputesRepository,
    private readonly solversService: SolversService,
    private readonly fillVerifier: FillVerifierService,
  ) {}

  async submit(solver: string, input: SubmitDisputeInput): Promise<Dispute> {
    const slash = await this.solversService.getSlash(input.slashId);
    if (!slash) throw new NotFoundException("Slash not found");
    if (slash.solver !== solver) {
      throw new ForbiddenException("A dispute may only be filed by the slashed solver");
    }

    const now = Math.floor(Date.now() / 1000);
    if (now - slash.timestamp > DISPUTE_WINDOW_SECONDS) {
      throw new BadRequestException("The dispute window has closed for this slash");
    }

    const existing = await this.repo.findActiveBySlashId(input.slashId);
    if (existing) {
      throw new ConflictException("An active dispute already exists for this slash");
    }

    const autoVerification = await this.fillVerifier.verify(slash.intentId, input.evidence.txHashes);

    const dispute: Dispute = {
      disputeId: randomUUID(),
      slashId: input.slashId,
      solver,
      intentId: slash.intentId,
      reason: input.reason,
      evidence: input.evidence,
      status: "open",
      submittedAt: now,
      deadline: now + DISPUTE_SLA_SECONDS,
      autoVerification,
    };
    return this.repo.save(dispute);
  }

  async review(disputeId: string): Promise<Dispute> {
    const dispute = await this.requireDispute(disputeId);
    if (dispute.status !== "open") {
      throw new ConflictException(`Cannot review a dispute in state "${dispute.status}"`);
    }
    return this.repo.save({ ...dispute, status: "under_review" });
  }

  async decide(
    disputeId: string,
    resolution: DisputeResolution,
    reviewer: string,
    reason: string,
  ): Promise<Dispute> {
    const dispute = await this.requireDispute(disputeId);
    if (dispute.status !== "under_review") {
      throw new ConflictException(`Cannot decide a dispute in state "${dispute.status}"`);
    }
    if (!reason || !reason.trim()) {
      throw new BadRequestException("A decision reason is required");
    }

    const now = Math.floor(Date.now() / 1000);

    if (resolution === "overturned") {
      // Reverse the local penalty (decrements fillsFailed, restoring the
      // solver's leaderboard reputation) and record a treasury refund request
      // for the on-chain compensation to be processed separately.
      await this.solversService.rollbackPenalty(dispute.intentId);
      await this.repo.saveRefund({
        refundId: randomUUID(),
        disputeId: dispute.disputeId,
        solver: dispute.solver,
        slashId: dispute.slashId,
        status: "pending",
        createdAt: now,
      });
    }

    return this.repo.save({
      ...dispute,
      status: resolution,
      decidedAt: now,
      decidedBy: reviewer,
      decisionReason: reason,
    });
  }

  async list(): Promise<Dispute[]> {
    return this.repo.findAll();
  }

  async get(disputeId: string): Promise<Dispute> {
    return this.requireDispute(disputeId);
  }

  async getRefunds(solver: string): Promise<TreasuryRefundRequest[]> {
    return this.repo.findRefundsBySolver(solver);
  }

  /** Public, anonymised dispute statistics (no solver addresses exposed). */
  async statistics(): Promise<DisputeStatistics> {
    const all = await this.repo.findAll();
    const decided = all.filter((d) => d.decidedAt != null);
    const overturned = decided.filter((d) => d.status === "overturned");
    const totalResolution = decided.reduce((sum, d) => sum + (d.decidedAt! - d.submittedAt), 0);

    return {
      total: all.length,
      open: all.filter((d) => d.status === "open").length,
      underReview: all.filter((d) => d.status === "under_review").length,
      upheld: decided.filter((d) => d.status === "upheld").length,
      overturned: overturned.length,
      overturnRate: decided.length ? overturned.length / decided.length : 0,
      avgResolutionSeconds: decided.length ? Math.round(totalResolution / decided.length) : 0,
      withinSla: decided.filter((d) => d.decidedAt! <= d.deadline).length,
    };
  }

  private async requireDispute(disputeId: string): Promise<Dispute> {
    const dispute = await this.repo.findById(disputeId);
    if (!dispute) throw new NotFoundException("Dispute not found");
    return dispute;
  }
}
