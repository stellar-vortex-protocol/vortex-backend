/**
 * PartialFillService (issue #427) against the real IntentsService and the
 * in-memory adapters — reservation races, tranche fills, settlement,
 * per-tranche slashing and remainder cancellation.
 */
import { ConfigService } from "@nestjs/config";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
} from "@nestjs/common";
import { AppConfig } from "../../config/configuration";
import { IntentsService } from "../intents.service";
import { InMemoryIntentsRepository } from "../intents.repository";
import { IntentsGateway } from "../intents.gateway";
import { Intent } from "../intents.types";
import { StellarTxService } from "../../soroban/stellar-tx.service";
import { PrismaService } from "../../prisma/prisma.service";
import { ProtocolParamsService } from "../../governance/params.service";
import { SolversService } from "../../solvers/solvers.service";
import { InMemoryIntentFillsRepository } from "./intent-fills.repository";
import { PartialFillService } from "./partial-fill.service";
import { allocation } from "./partial-fill.math";

const NOW = 1_900_000_000;

function makeIntentsService(): IntentsService {
  const config = { get: jest.fn().mockReturnValue(false) } as unknown as ConfigService<AppConfig, true>;
  const prisma = {
    intentAuditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const params = {
    snapshotForChain: jest.fn().mockReturnValue({ version: 0, feeBps: 30, deadlineSeconds: 1800, fillWindowSeconds: 600 }),
  } as unknown as ProtocolParamsService;
  return new IntentsService(new InMemoryIntentsRepository(), config, {} as StellarTxService, prisma, params);
}

function setup() {
  const intents = makeIntentsService();
  const fills = new InMemoryIntentFillsRepository();
  const gateway = { broadcast: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<IntentsGateway>;
  const solvers = {
    recordSuccessfulFill: jest.fn().mockResolvedValue(null),
    recordFailedFill: jest.fn().mockResolvedValue(null),
    recordSlash: jest.fn().mockResolvedValue({ slashId: "slash-1" }),
  } as unknown as jest.Mocked<SolversService>;
  const config = {
    get: jest.fn((key: string) => (key === "partialFills" ? { enabled: true, onchainEnabled: false } : undefined)),
  } as unknown as ConfigService<AppConfig, true>;
  const service = new PartialFillService(intents, fills, gateway, solvers, config);
  return { intents, fills, gateway, solvers, service };
}

async function createIntent(
  intents: IntentsService,
  overrides: Partial<Intent> = {},
): Promise<Intent> {
  jest.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  const intent = await intents.create({
    user: "GUSERPARTIALFILLTEST0000000000000000000000000000000000",
    srcChain: "stellar",
    srcToken: { address: "CSRC", symbol: "USDC", name: "USDC", decimals: 7, chain: "stellar" },
    srcAmount: "1000",
    dstToken: { contract: "CDST", symbol: "USDC", decimals: 7 },
    minDstAmount: "900",
    deadline: NOW + 3600,
    allowPartialFill: true,
    minFillAmount: "100",
    ...overrides,
  });
  (Date.now as jest.Mock).mockRestore();
  return intent;
}

const solver = (n: number) => `GSOLVER${String(n).padStart(2, "0")}`;

describe("PartialFillService (issue #427)", () => {
  afterEach(() => jest.restoreAllMocks());

  describe("concurrent reservations", () => {
    it("10 solvers reserving at once never over-reserve: Σ reserved ≤ srcAmount", async () => {
      const { intents, fills, service } = setup();
      const intent = await createIntent(intents);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => service.reserve(intent, solver(i), "150", NOW)),
      );

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(6); // 6 × 150 = 900
      expect(lost).toHaveLength(4);
      for (const r of lost) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

      const { reserved, remaining } = allocation(intent.srcAmount, await fills.listByIntent(intent.intentId));
      expect(reserved).toBe(900n);
      expect(remaining).toBe(100n);
    });

    it("random-sized concurrent reservations hold the invariant across many runs", async () => {
      for (let run = 0; run < 20; run++) {
        const { intents, fills, service } = setup();
        const intent = await createIntent(intents, { srcAmount: "10000", minFillAmount: "1" });
        await Promise.allSettled(
          Array.from({ length: 10 }, (_, i) =>
            service.reserve(intent, solver(i), String(1 + Math.floor(Math.random() * 3000)), NOW),
          ),
        );
        const { reserved, filled, remaining } = allocation(intent.srcAmount, await fills.listByIntent(intent.intentId));
        expect(reserved + filled + remaining).toBe(10000n);
        expect(reserved <= 10000n).toBe(true);
      }
    });

    it("the last tranche may be smaller than minFillAmount when it takes the whole remainder", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents);
      await service.reserve(intent, solver(1), "950", NOW);
      await expect(service.reserve(intent, solver(2), "40", NOW)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.reserve(intent, solver(2), "50", NOW)).resolves.toMatchObject({
        fill: { reservedAmount: "50" },
      });
    });

    it("rejects reservations on an intent without allowPartialFill", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents, { allowPartialFill: false, minFillAmount: undefined });
      await expect(service.reserve(intent, solver(1), "100", NOW)).rejects.toBeInstanceOf(ConflictException);
    });

    it("caps the tranche deadline at the intent deadline", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents, { deadline: NOW + 60 });
      const { fill } = await service.reserve(intent, solver(1), "100", NOW);
      expect(fill.deadline).toBe(NOW + 60);
    });
  });

  describe("tranche fills and settlement", () => {
    it("fills tranches, reports partially_filled, and settles to filled when nothing is left", async () => {
      const { intents, gateway, solvers, service } = setup();
      const intent = await createIntent(intents);
      const a = await service.reserve(intent, solver(1), "600", NOW);
      const b = await service.reserve(intent, solver(2), "400", NOW);
      // Pro-rata minimums: 900 × 600/1000 = 540, 900 × 400/1000 = 360.
      expect(a.fill.minDstAmount).toBe("540");
      expect(b.fill.minDstAmount).toBe("360");

      const first = await service.fillTranche(intent, a.fill.fillId, solver(1), "545", "tx-a", NOW + 10);
      expect(first.settled).toBe(false);
      expect(first.intent.state).toBe("open");
      expect(first.intent.fillProgress).toMatchObject({
        status: "partially_filled",
        filledAmount: "600",
        reservedAmount: "400",
        remainingAmount: "0",
      });
      expect(gateway.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "intent_partially_filled", intentId: intent.intentId, fillId: a.fill.fillId }),
      );
      expect(solvers.recordSuccessfulFill).toHaveBeenCalledWith(solver(1), "545");

      const second = await service.fillTranche(intent, b.fill.fillId, solver(2), "360", "tx-b", NOW + 20);
      expect(second.settled).toBe(true);
      expect(second.intent).toMatchObject({
        state: "filled",
        fillAmount: "905",
        solver: solver(2),
        txHash: "tx-b",
        fillProgress: { status: "filled", filledAmount: "1000", dstFilledAmount: "905", fillCount: 2 },
      });
      expect(gateway.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "intent_filled", intentId: intent.intentId, partial: true, fillAmount: "905" }),
      );
    });

    it("rejects a delivery below the tranche's pro-rata minimum", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents);
      const { fill } = await service.reserve(intent, solver(1), "500", NOW);
      await expect(service.fillTranche(intent, fill.fillId, solver(1), "449", undefined, NOW + 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("only the reserving solver may fill, and only inside the tranche window", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents);
      const { fill } = await service.reserve(intent, solver(1), "500", NOW);
      await expect(service.fillTranche(intent, fill.fillId, solver(2), "450", undefined, NOW + 1)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        service.fillTranche(intent, fill.fillId, solver(1), "450", undefined, fill.deadline),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it("a tranche cannot be filled twice", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents);
      const { fill } = await service.reserve(intent, solver(1), "500", NOW);
      await service.fillTranche(intent, fill.fillId, solver(1), "450", undefined, NOW + 1);
      await expect(service.fillTranche(intent, fill.fillId, solver(1), "450", undefined, NOW + 2)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe("slashing", () => {
    it("slashes only the unfilled tranche's solver and returns that amount to the pool", async () => {
      const { intents, fills, solvers, gateway, service } = setup();
      const intent = await createIntent(intents);
      const kept = await service.reserve(intent, solver(1), "300", NOW);
      const lapsed = await service.reserve(intent, solver(2), "700", NOW);
      await service.fillTranche(intent, kept.fill.fillId, solver(1), "270", undefined, NOW + 5);

      const slashed = await service.slashExpiredReservations(lapsed.fill.deadline);
      expect(slashed).toBe(1);
      expect(solvers.recordSlash).toHaveBeenCalledTimes(1);
      expect(solvers.recordSlash).toHaveBeenCalledWith(solver(2), intent.intentId, expect.stringContaining("700"), lapsed.fill.deadline);
      expect(solvers.recordFailedFill).toHaveBeenCalledWith(solver(2), intent.intentId);
      expect(gateway.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "intent_tranche_slashed", solver: solver(2), slashedAmount: "700" }),
      );

      const after = allocation(intent.srcAmount, await fills.listByIntent(intent.intentId));
      expect(after).toMatchObject({ filled: 300n, reserved: 0n, remaining: 700n });
      // The freed amount is reservable by someone else.
      await expect(service.reserve(intent, solver(3), "700", lapsed.fill.deadline - 1)).resolves.toBeDefined();
      // The intent itself was not slashed.
      expect((await intents.get(intent.intentId))?.state).toBe("open");
    });

    it("a fill that lands first beats the sweeper's slash", async () => {
      const { intents, solvers, service } = setup();
      const intent = await createIntent(intents);
      const { fill } = await service.reserve(intent, solver(1), "1000", NOW);
      await service.fillTranche(intent, fill.fillId, solver(1), "900", undefined, fill.deadline - 1);
      expect(await service.slashExpiredReservations(fill.deadline + 10)).toBe(0);
      expect(solvers.recordSlash).not.toHaveBeenCalled();
    });

    it("does not slash a reservation whose window is still open", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents);
      const { fill } = await service.reserve(intent, solver(1), "100", NOW);
      expect(await service.slashExpiredReservations(fill.deadline - 1)).toBe(0);
    });
  });

  describe("cancel", () => {
    it("is refused while reservations are outstanding", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents);
      await service.reserve(intent, solver(1), "100", NOW);
      await expect(service.cancelRemainder(intent, intent.user, NOW + 1)).rejects.toBeInstanceOf(ConflictException);
    });

    it("cancels the remainder of a partially filled intent and settles it as filled", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents);
      const { fill } = await service.reserve(intent, solver(1), "400", NOW);
      await service.fillTranche(intent, fill.fillId, solver(1), "360", undefined, NOW + 1);

      const outcome = await service.cancelRemainder(intent, intent.user, NOW + 2);
      expect(outcome.settled).toBe(true);
      expect(outcome.intent).toMatchObject({
        state: "filled",
        fillAmount: "360",
        fillProgress: { status: "partially_filled", filledAmount: "400", remainderCancelled: true },
      });
      // Nothing more can be reserved once settled.
      await expect(service.reserve((await intents.get(intent.intentId))!, solver(2), "600", NOW + 3)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("is an ordinary cancel when nothing has been filled", async () => {
      const { intents, service } = setup();
      const intent = await createIntent(intents);
      const outcome = await service.cancelRemainder(intent, intent.user, NOW + 1);
      expect(outcome).toMatchObject({ settled: false, intent: { state: "cancelled" } });
    });
  });

  it("withProgress leaves ordinary intents untouched", async () => {
    const { intents, service } = setup();
    const plain = await createIntent(intents, { allowPartialFill: false, minFillAmount: undefined });
    const partial = await createIntent(intents);
    const [a, b] = await service.withProgress([plain, partial]);
    expect(a.fillProgress).toBeUndefined();
    expect(b.fillProgress).toMatchObject({ status: "none", remainingAmount: "1000" });
  });
});
