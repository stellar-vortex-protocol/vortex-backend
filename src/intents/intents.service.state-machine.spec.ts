import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProtocolParamsService } from "../governance/params.service";
import { IntentsService } from "./intents.service";
import { InMemoryIntentsRepository } from "./intents.repository";
import { Intent, IntentState } from "./intents.types";
import { IllegalTransitionError } from "./state-machine";

/**
 * Issue #406 — every state change made by IntentsService is planned by the
 * state machine's `transition()` and audited by the service itself, so no
 * caller can change state without leaving an audit entry.
 */

const CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function build(opts: { onchain?: boolean } = {}) {
  const repo = new InMemoryIntentsRepository({ seed: false });
  const auditCreate = jest.fn().mockResolvedValue({});
  const config = {
    get: (path: string) =>
      ({ onchainIntentsEnabled: opts.onchain ?? false, "stellar.settlementContractId": CONTRACT_ID })[path],
  } as unknown as ConfigService<AppConfig, true>;
  const stellarTx = {
    invokeContract: jest.fn().mockResolvedValue({ hash: "chain-tx" }),
  } as unknown as StellarTxService;
  const prisma = { intentAuditLog: { create: auditCreate } } as unknown as PrismaService;
  const params = {
    snapshotForChain: () => ({ version: 0, feeBps: 30, deadlineSeconds: 1800, fillWindowSeconds: 600 }),
  } as unknown as ProtocolParamsService;
  const service = new IntentsService(repo, config, stellarTx, prisma, params);
  return { service, repo, auditCreate };
}

function seed(repo: InMemoryIntentsRepository, state: IntentState, extra: Partial<Intent> = {}): Intent {
  const now = Math.floor(Date.now() / 1000);
  const intent: Intent = {
    intentId: `sm-${state}-${Math.random().toString(36).slice(2)}`,
    user: Keypair.random().publicKey(),
    srcChain: "base",
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "base" },
    srcAmount: "1000000",
    dstToken: { contract: CONTRACT_ID, symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state,
    createdAt: now,
    deadline: now + 600,
    version: 0,
    ...extra,
  };
  repo.save(intent);
  return intent;
}

describe("IntentsService × state machine (issue #406)", () => {
  it("accept writes exactly one audit entry with the actor, from-state and new deadline", async () => {
    const { service, repo, auditCreate } = build();
    const solver = Keypair.random().publicKey();
    const intent = seed(repo, "open");

    const updated = await service.acceptIfOpen(intent.intentId, solver);

    expect(updated?.state).toBe("accepted");
    expect(service.getAuditLog(intent.intentId)).toEqual([
      expect.objectContaining({
        toState: "accepted",
        actor: solver,
        reason: "solver accepted",
        metadata: { deadline: updated?.deadline, fromState: "open" },
      }),
    ]);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it("a lost race writes no audit entry", async () => {
    const { service, repo, auditCreate } = build();
    const intent = seed(repo, "cancelled");

    expect(await service.acceptIfOpen(intent.intentId, Keypair.random().publicKey())).toBeNull();
    expect(await service.expireIfOpen(intent.intentId)).toBeNull();
    expect(service.getAuditLog(intent.intentId)).toEqual([]);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("caller context overrides the default actor/reason and merges metadata", async () => {
    const { service, repo } = build();
    const intent = seed(repo, "open");

    await service.cancelIfOpen(intent.intentId, {
      actor: intent.user,
      reason: "user cancelled",
      metadata: { via: "api" },
    });

    expect(service.getAuditLog(intent.intentId)).toEqual([
      expect.objectContaining({
        toState: "cancelled",
        actor: intent.user,
        metadata: { via: "api", fromState: "open" },
      }),
    ]);
  });

  it("slash and expire default to the system actor", async () => {
    const { service, repo } = build();
    const accepted = seed(repo, "accepted", { solver: "GSOLVER" });
    const open = seed(repo, "open");

    await service.slashIfAccepted(accepted.intentId, { slashedAt: 1, slashReason: "missed" });
    await service.expireIfOpen(open.intentId);

    expect(service.getAuditLog(accepted.intentId)[0]).toMatchObject({
      toState: "slashed",
      actor: "system",
      reason: "missed",
      metadata: { solver: "GSOLVER", slashedAt: 1, fromState: "accepted" },
    });
    expect(service.getAuditLog(open.intentId)[0]).toMatchObject({
      toState: "expired",
      actor: "system",
      reason: "deadline passed",
    });
  });

  it("onchain parks and confirmations are audited as their own transitions", async () => {
    const { service, repo } = build({ onchain: true });
    const solver = Keypair.random().publicKey();
    const intent = seed(repo, "open");

    const parked = await service.acceptIfOpen(intent.intentId, solver);
    expect(parked?.state).toBe("pending_accepted");
    const confirmed = await service.confirmIntent(intent.intentId);
    expect(confirmed?.state).toBe("accepted");

    expect(service.getAuditLog(intent.intentId).map((e) => [e.metadata?.fromState, e.toState])).toEqual([
      ["open", "accepted"],
      ["accepted", "pending_accepted"],
      ["pending_accepted", "accepted"],
    ]);
    expect(service.getAuditLog(intent.intentId)[1].metadata).toMatchObject({ op: "accept", txHash: "chain-tx" });
  });

  it("refuses to park from a state with no matching edge", async () => {
    const { service, repo } = build();
    const intent = seed(repo, "expired");

    await expect(service.transitionToOnChainPending(intent.intentId, "fill")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    expect((await service.get(intent.intentId))?.state).toBe("expired");
  });

  describe("compensateSlash", () => {
    it("moves slashed → filled with the override and audits it", async () => {
      const { service, repo } = build();
      const intent = seed(repo, "slashed", { solver: "GSOLVER" });

      const updated = await service.compensateSlash(
        intent.intentId,
        "filled",
        { actor: "system", reason: "slash cancelled: fill_landed" },
        { txHash: "late-fill" },
      );

      expect(updated).toMatchObject({ state: "filled", txHash: "late-fill" });
      expect(service.getAuditLog(intent.intentId)).toEqual([
        expect.objectContaining({
          toState: "filled",
          reason: "slash cancelled: fill_landed",
          metadata: { fromState: "slashed" },
        }),
      ]);
    });

    it("is a no-op unless the intent is currently slashed", async () => {
      const { service, repo } = build();
      const intent = seed(repo, "filled");

      expect(await service.compensateSlash(intent.intentId, "expired", { actor: "system" })).toBeNull();
      expect(await service.compensateSlash("missing", "expired", { actor: "system" })).toBeNull();
      expect((await service.get(intent.intentId))?.state).toBe("filled");
      expect(service.getAuditLog(intent.intentId)).toEqual([]);
    });
  });
});
