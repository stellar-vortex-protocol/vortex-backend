import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { buildFillProofMessage } from "../common/stellar-signature";
import { AdminAuditService } from "../admin/admin-audit.service";
import { AdminSlashesController, SlashesController } from "./slashes.controller";
import { SlashingPipelineService } from "./slashing-pipeline.service";

describe("SlashesController (#397)", () => {
  const pipeline = {
    getByIntent: jest.fn(),
    cancelByFillProof: jest.fn().mockResolvedValue({ state: "cancelled" }),
    cancelByAdmin: jest.fn().mockResolvedValue({ state: "cancelled" }),
    list: jest.fn().mockResolvedValue([{ intentId: "i1" }]),
  };
  const controller = new SlashesController(pipeline as unknown as SlashingPipelineService);
  const solver = Keypair.random();
  const txHash = "AB".repeat(32);

  it("returns a slash or 404", async () => {
    pipeline.getByIntent.mockResolvedValueOnce({ intentId: "i1" });
    await expect(controller.get("i1")).resolves.toEqual({ intentId: "i1" });
    pipeline.getByIntent.mockResolvedValueOnce(undefined);
    await expect(controller.get("i2")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("verifies the solver's signature over the lowercased tx hash before cancelling", async () => {
    const message = buildFillProofMessage("i1", solver.publicKey(), txHash.toLowerCase());
    const signature = solver.sign(Buffer.from(message)).toString("base64");

    await controller.fillProof("i1", { solver: solver.publicKey(), txHash, signature });
    expect(pipeline.cancelByFillProof).toHaveBeenCalledWith("i1", solver.publicKey(), txHash.toLowerCase());
  });

  it("rejects a fill proof signed by someone else", async () => {
    pipeline.cancelByFillProof.mockClear();
    const signature = Keypair.random()
      .sign(Buffer.from(buildFillProofMessage("i1", solver.publicKey(), txHash.toLowerCase())))
      .toString("base64");
    await expect(controller.fillProof("i1", { solver: solver.publicKey(), txHash, signature })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(pipeline.cancelByFillProof).not.toHaveBeenCalled();
  });

  describe("AdminSlashesController", () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const admin = new AdminSlashesController(
      pipeline as unknown as SlashingPipelineService,
      audit as unknown as AdminAuditService,
    );
    const principal = { id: "ops-1", role: "admin" as const };

    it("lists slashes", async () => {
      await expect(admin.list({})).resolves.toEqual({ slashes: [{ intentId: "i1" }], count: 1 });
      expect(pipeline.list).toHaveBeenCalledWith(undefined, 50);
      await admin.list({ state: "submitted", limit: 5 });
      expect(pipeline.list).toHaveBeenLastCalledWith("submitted", 5);
    });

    it("audits a cancel before applying it, attributing it to the authenticated admin", async () => {
      const order: string[] = [];
      audit.record.mockImplementationOnce(async () => void order.push("audit"));
      pipeline.cancelByAdmin.mockImplementationOnce(async () => {
        order.push("cancel");
        return { state: "cancelled" };
      });

      await admin.cancel("i1", { note: "manual review" }, principal);

      expect(order).toEqual(["audit", "cancel"]);
      expect(audit.record).toHaveBeenCalledWith({
        actor: "ops-1",
        action: "slash.cancel",
        target: "slash:i1",
        reason: "manual review",
      });
      expect(pipeline.cancelByAdmin).toHaveBeenCalledWith("i1", "ops-1", "manual review");
    });

    it("does not cancel when the audit write fails", async () => {
      pipeline.cancelByAdmin.mockClear();
      audit.record.mockRejectedValueOnce(new Error("audit down"));
      await expect(admin.cancel("i1", { note: "manual review" }, principal)).rejects.toThrow("audit down");
      expect(pipeline.cancelByAdmin).not.toHaveBeenCalled();
    });
  });
});
