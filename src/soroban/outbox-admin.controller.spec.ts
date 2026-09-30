import { NotFoundException } from "@nestjs/common";
import { AdminAuditService } from "../admin/admin-audit.service";
import { InMemoryOutboxRepository } from "./outbox.repository";
import { OutboxAdminController } from "./outbox-admin.controller";

describe("OutboxAdminController (#396)", () => {
  const principal = { id: "ops-1", role: "admin" as const };

  it("audits and requeues dead rows, 404s everything else", async () => {
    const outbox = new InMemoryOutboxRepository();
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new OutboxAdminController(outbox, audit as unknown as AdminAuditService);
    const row = await outbox.enqueue({ intentId: "i1", operation: "create_intent", payload: {} });
    const [claimed] = await outbox.claimDue(new Date(Date.now() + 1000), 1, new Date(Date.now() + 60_000));
    await outbox.markDead(claimed, "poison");

    await expect(controller.requeue(row.id, principal)).resolves.toEqual({ id: row.id, status: "pending" });
    expect(audit.record).toHaveBeenCalledWith({ actor: "ops-1", action: "outbox.requeue", target: `outbox:${row.id}` });

    await expect(controller.requeue(row.id, principal)).rejects.toBeInstanceOf(NotFoundException);
    audit.record.mockClear();
    await expect(controller.requeue("not-a-number", principal)).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("does not requeue when the audit write fails", async () => {
    const outbox = new InMemoryOutboxRepository();
    const requeue = jest.spyOn(outbox, "requeueDead");
    const audit = { record: jest.fn().mockRejectedValue(new Error("audit down")) };
    const controller = new OutboxAdminController(outbox, audit as unknown as AdminAuditService);
    await expect(controller.requeue("1", principal)).rejects.toThrow("audit down");
    expect(requeue).not.toHaveBeenCalled();
  });
});
