import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { DisputesService } from "./disputes.service";
import { InMemoryDisputesRepository } from "./disputes.repository";
import { FillVerifierService } from "./fill-verifier.service";
import { SolversService } from "../solvers/solvers.service";
import { SlashRecord } from "../solvers/solvers.service";
import { DISPUTE_SLA_SECONDS, DISPUTE_WINDOW_SECONDS } from "./disputes.types";

function slashRecord(overrides: Partial<SlashRecord> = {}): SlashRecord {
  return {
    slashId: "slash-1",
    solver: "GSOLVER",
    intentId: "intent-1",
    reason: "missed deadline",
    timestamp: Math.floor(Date.now() / 1000) - 100,
    disputeStatus: "none",
    ...overrides,
  };
}

function makeService(overrides: { slash?: SlashRecord | null; verify?: { verified: boolean; reason: string } } = {}) {
  const repo = new InMemoryDisputesRepository();
  const slash = overrides.slash === undefined ? slashRecord() : overrides.slash;
  const solversService = {
    getSlash: jest.fn().mockResolvedValue(slash),
    rollbackPenalty: jest.fn().mockResolvedValue({}),
  } as unknown as SolversService;
  const fillVerifier = {
    verify: jest.fn().mockResolvedValue(overrides.verify ?? { verified: true, reason: "tx matches" }),
  } as unknown as FillVerifierService;
  const service = new DisputesService(repo, solversService, fillVerifier);
  return { service, repo, solversService, fillVerifier };
}

const evidence = { txHashes: ["tx-abc"], logs: [] };
const input = { slashId: "slash-1", reason: "RPC lag", evidence };

describe("DisputesService", () => {
  describe("submit", () => {
    it("creates an open dispute with an SLA deadline and auto-verification", async () => {
      const { service } = makeService();
      const dispute = await service.submit("GSOLVER", input);

      expect(dispute.status).toBe("open");
      expect(dispute.solver).toBe("GSOLVER");
      expect(dispute.slashId).toBe("slash-1");
      expect(dispute.deadline).toBe(dispute.submittedAt + DISPUTE_SLA_SECONDS);
      expect(dispute.autoVerification.verified).toBe(true);
    });

    it("rejects an unknown slash", async () => {
      const { service } = makeService({ slash: null });
      await expect(service.submit("GSOLVER", input)).rejects.toThrow(NotFoundException);
    });

    it("rejects a dispute filed by a solver other than the slashed solver", async () => {
      const { service } = makeService();
      await expect(service.submit("GOTHER", input)).rejects.toThrow();
    });

    it("rejects a dispute after the window has closed", async () => {
      const old = slashRecord({ timestamp: Math.floor(Date.now() / 1000) - DISPUTE_WINDOW_SECONDS - 60 });
      const { service } = makeService({ slash: old });
      await expect(service.submit("GSOLVER", input)).rejects.toThrow(BadRequestException);
    });

    it("rejects a second active dispute for the same slash", async () => {
      const { service } = makeService();
      await service.submit("GSOLVER", input);
      await expect(service.submit("GSOLVER", input)).rejects.toThrow(ConflictException);
    });
  });

  describe("review", () => {
    it("transitions open → under_review", async () => {
      const { service } = makeService();
      const dispute = await service.submit("GSOLVER", input);
      const reviewed = await service.review(dispute.disputeId);
      expect(reviewed.status).toBe("under_review");
    });

    it("rejects reviewing a non-open dispute", async () => {
      const { service } = makeService();
      const dispute = await service.submit("GSOLVER", input);
      await service.review(dispute.disputeId);
      await expect(service.review(dispute.disputeId)).rejects.toThrow(ConflictException);
    });
  });

  describe("decide", () => {
    it("overturns: calls rollbackPenalty and creates a treasury refund request", async () => {
      const { service, repo, solversService } = makeService();
      const dispute = await service.submit("GSOLVER", input);
      await service.review(dispute.disputeId);

      const decided = await service.decide(dispute.disputeId, "overturned", "REVIEWER_A", "evidence confirms the fill");

      expect(decided.status).toBe("overturned");
      expect(decided.decidedBy).toBe("REVIEWER_A");
      expect(decided.decisionReason).toBe("evidence confirms the fill");
      expect(decided.decidedAt).toBeDefined();
      expect(solversService.rollbackPenalty).toHaveBeenCalledWith("intent-1");

      const refunds = await repo.findRefundsBySolver("GSOLVER");
      expect(refunds).toHaveLength(1);
      expect(refunds[0].disputeId).toBe(dispute.disputeId);
      expect(refunds[0].slashId).toBe("slash-1");
    });

    it("upholds: does not roll back or create a refund", async () => {
      const { service, repo, solversService } = makeService();
      const dispute = await service.submit("GSOLVER", input);
      await service.review(dispute.disputeId);

      await service.decide(dispute.disputeId, "upheld", "REVIEWER_A", "no evidence of a fill");

      expect(solversService.rollbackPenalty).not.toHaveBeenCalled();
      expect(await repo.findRefundsBySolver("GSOLVER")).toHaveLength(0);
    });

    it("requires a decision reason", async () => {
      const { service } = makeService();
      const dispute = await service.submit("GSOLVER", input);
      await service.review(dispute.disputeId);

      await expect(service.decide(dispute.disputeId, "upheld", "REVIEWER_A", "  ")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects deciding an already-decided dispute (immutability)", async () => {
      const { service } = makeService();
      const dispute = await service.submit("GSOLVER", input);
      await service.review(dispute.disputeId);
      await service.decide(dispute.disputeId, "upheld", "REVIEWER_A", "reason");

      await expect(service.decide(dispute.disputeId, "overturned", "REVIEWER_A", "reason")).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe("statistics", () => {
    it("reports anonymised counts and rates without exposing solvers", async () => {
      const { service } = makeService();
      const d1 = await service.submit("GSOLVER", input);
      await service.review(d1.disputeId);
      await service.decide(d1.disputeId, "overturned", "REVIEWER_A", "reason");

      const stats = await service.statistics();
      expect(stats.total).toBe(1);
      expect(stats.overturned).toBe(1);
      expect(stats.upheld).toBe(0);
      expect(stats.overturnRate).toBe(1);
      expect(stats).not.toHaveProperty("solvers");
      expect(JSON.stringify(stats)).not.toContain("GSOLVER");
    });
  });
});
