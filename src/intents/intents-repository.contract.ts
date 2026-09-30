import { v4 as uuidv4 } from "uuid";
import { IIntentsRepository, isVersionConflict, MutationResult, VersionConflict } from "./intents.repository";
import { Intent } from "./intents.types";

/**
 * Shared behavioural contract for every IIntentsRepository implementation
 * (issues #404 / #405). Each adapter's spec calls this with a factory so the
 * in-memory reference implementation and the Postgres adapter are held to
 * exactly the same semantics — including version bumps, conflict reporting,
 * and single-winner races.
 *
 * Not a spec file itself (no `.spec.ts` suffix) so Jest only runs it through
 * the adapters that import it.
 */
export function runIntentsRepositoryContract(
  name: string,
  factory: () => Promise<IIntentsRepository> | IIntentsRepository,
): void {
  describe(`IIntentsRepository contract — ${name}`, () => {
    let repo: IIntentsRepository;
    const now = Math.floor(Date.now() / 1000);

    beforeEach(async () => {
      repo = await factory();
    });

    function makeIntent(overrides: Partial<Intent> = {}): Intent {
      return {
        intentId: uuidv4(),
        user: `GCONTRACTUSER${uuidv4().slice(0, 8).toUpperCase()}`,
        srcChain: "ethereum",
        srcToken: {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          chain: "ethereum",
        },
        srcAmount: "1000000",
        dstToken: { contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", symbol: "USDC", decimals: 7 },
        minDstAmount: "990000",
        state: "open",
        createdAt: now,
        deadline: now + 3600,
        version: 0,
        srcVerified: true,
        ...overrides,
      };
    }

    async function seeded(overrides: Partial<Intent> = {}): Promise<Intent> {
      return repo.save(makeIntent(overrides));
    }

    function asIntent(result: MutationResult): Intent {
      if (!result || isVersionConflict(result)) {
        throw new Error(`expected an intent, got ${JSON.stringify(result)}`);
      }
      return result;
    }

    describe("reads", () => {
      it("round-trips every field through save/findById", async () => {
        const intent = makeIntent({
          quotedDstAmount: "995000",
          solver: "GSOLVER",
          state: "filled",
          filledAt: now,
          fillAmount: "995000",
          feeAmount: "497",
          txHash: "abc123",
          version: 7,
          srcVerified: false,
          srcTxHash: "0x" + "ab".repeat(32),
          srcVerification: { status: "pending", checkedAt: now, blockNumber: "123", blockHash: "0xhash", detail: "3/12 confirmations" },
        });
        await repo.save(intent);
        expect(await repo.findById(intent.intentId)).toEqual(intent);
      });

      it("returns undefined for an unknown id", async () => {
        expect(await repo.findById(uuidv4())).toBeUndefined();
      });

      it("findManyByIds de-duplicates and omits unknown IDs", async () => {
        const a = await seeded();
        const b = await seeded();
        const found = await repo.findManyByIds([a.intentId, b.intentId, a.intentId, uuidv4()]);
        expect(found.map((i) => i.intentId).sort()).toEqual([a.intentId, b.intentId].sort());
        expect(await repo.findManyByIds([])).toEqual([]);
      });

      it("findByState returns matches newest-first", async () => {
        const older = await seeded({ state: "expired", createdAt: now - 10 });
        const newer = await seeded({ state: "expired", createdAt: now + 10 });
        const ids = (await repo.findByState("expired")).map((i) => i.intentId);
        expect(ids.indexOf(newer.intentId)).toBeLessThan(ids.indexOf(older.intentId));
      });

      it("findByUser matches addresses case-insensitively", async () => {
        const intent = await seeded({ user: "GMixedCaseUser" });
        const found = await repo.findByUser("gmixedcaseuser");
        expect(found.map((i) => i.intentId)).toContain(intent.intentId);
      });

      it("counts accepted intents per solver and active intents per user", async () => {
        const solver = `GSOLVER${uuidv4().slice(0, 6)}`;
        const user = `GUSER${uuidv4().slice(0, 6)}`;
        await seeded({ state: "accepted", solver, user });
        await seeded({ state: "accepted", solver, user: user.toLowerCase() });
        await seeded({ state: "open", user });
        await seeded({ state: "filled", solver, user });
        expect(await repo.countAcceptedBySolver(solver)).toBe(2);
        expect(await repo.countActiveByUser(user)).toBe(3);
      });
    });

    describe("update(id, patch, expectedVersion)", () => {
      it("patches source-verification fields (issue #403)", async () => {
        const intent = await seeded({ srcVerified: false });
        const verification = { status: "verified" as const, checkedAt: now, receivedAmount: "1000000" };
        const updated = asIntent(
          await repo.update(intent.intentId, { srcVerified: true, srcVerification: verification }, 0),
        );
        expect(updated).toMatchObject({ srcVerified: true, srcVerification: verification, version: 1 });
        expect(await repo.findById(intent.intentId)).toMatchObject({ srcVerified: true, srcVerification: verification });
      });

      it("applies the patch and increments the version", async () => {
        const intent = await seeded();
        const updated = asIntent(await repo.update(intent.intentId, { quotedDstAmount: "1" }, 0));
        expect(updated.version).toBe(1);
        expect(updated.quotedDstAmount).toBe("1");
        expect((await repo.findById(intent.intentId))!.version).toBe(1);
      });

      it("returns a VersionConflict carrying the actual version on a stale write", async () => {
        const intent = await seeded({ version: 3 });
        const result = await repo.update(intent.intentId, { quotedDstAmount: "1" }, 2);
        expect(result).toBeInstanceOf(VersionConflict);
        expect(result).toMatchObject({ intentId: intent.intentId, expectedVersion: 2, actualVersion: 3 });
        expect((await repo.findById(intent.intentId))!.quotedDstAmount).toBeUndefined();
      });

      it("returns null for an unknown intent", async () => {
        expect(await repo.update(uuidv4(), { quotedDstAmount: "1" }, 0)).toBeNull();
      });
    });

    describe("conditional transitions", () => {
      const cases: Array<{
        name: string;
        from: Partial<Intent>;
        wrongFrom: Partial<Intent>;
        to: Intent["state"];
        run: (r: IIntentsRepository, id: string, v?: number) => unknown;
      }> = [
        {
          name: "acceptIfOpen",
          from: { state: "open" },
          wrongFrom: { state: "cancelled" },
          to: "accepted",
          run: (r, id, v) => r.acceptIfOpen(id, "GSOLVER", now + 600, undefined, v),
        },
        {
          name: "fillIfAccepted",
          from: { state: "accepted", solver: "GSOLVER" },
          wrongFrom: { state: "accepted", solver: "GOTHER" },
          to: "filled",
          run: (r, id, v) =>
            r.fillIfAccepted(id, "GSOLVER", { fillAmount: "995000", filledAt: now, txHash: "h" }, undefined, v),
        },
        {
          name: "cancelIfOpen",
          from: { state: "open" },
          wrongFrom: { state: "accepted", solver: "GSOLVER" },
          to: "cancelled",
          run: (r, id, v) => r.cancelIfOpen(id, v),
        },
        {
          name: "expireIfOpen",
          from: { state: "open" },
          wrongFrom: { state: "filled" },
          to: "expired",
          run: (r, id, v) => r.expireIfOpen(id, v),
        },
        {
          name: "extendDeadlineIfAccepted",
          from: { state: "accepted", solver: "GSOLVER" },
          wrongFrom: { state: "open" },
          to: "accepted",
          run: (r, id, v) => r.extendDeadlineIfAccepted(id, now + 99_999, v),
        },
        {
          name: "slashIfAccepted",
          from: { state: "accepted", solver: "GSOLVER" },
          wrongFrom: { state: "open" },
          to: "slashed",
          run: (r, id, v) => r.slashIfAccepted(id, { slashedAt: now, slashReason: "missed" }, v),
        },
      ];

      for (const c of cases) {
        describe(c.name, () => {
          it(`moves to ${c.to} and bumps the version`, async () => {
            const intent = await seeded(c.from);
            const updated = asIntent((await c.run(repo, intent.intentId)) as MutationResult);
            expect(updated.state).toBe(c.to);
            expect(updated.version).toBe(1);
          });

          it("honours a matching expected version", async () => {
            const intent = await seeded({ ...c.from, version: 4 });
            const updated = asIntent((await c.run(repo, intent.intentId, 4)) as MutationResult);
            expect(updated.version).toBe(5);
          });

          it("returns a VersionConflict for a stale expected version", async () => {
            const intent = await seeded({ ...c.from, version: 4 });
            const result = await c.run(repo, intent.intentId, 3);
            expect(result).toBeInstanceOf(VersionConflict);
            expect((await repo.findById(intent.intentId))!.state).toBe(c.from.state);
          });

          it("returns null when the state guard fails", async () => {
            const intent = await seeded(c.wrongFrom);
            expect(await c.run(repo, intent.intentId)).toBeNull();
            expect((await repo.findById(intent.intentId))!.version).toBe(0);
          });

          it("returns null for an unknown intent", async () => {
            expect(await c.run(repo, uuidv4())).toBeNull();
          });
        });
      }

      it("refuses to accept or fill once the deadline has passed (issue #473)", async () => {
        const lapsedOpen = await seeded({ deadline: now - 1 });
        expect(await repo.acceptIfOpen(lapsedOpen.intentId, "GSOLVER", now + 600)).toBeNull();

        const lapsedAccepted = await seeded({ state: "accepted", solver: "GSOLVER", deadline: now - 1 });
        expect(await repo.fillIfAccepted(lapsedAccepted.intentId, "GSOLVER", { fillAmount: "1" })).toBeNull();

        // An explicit `now` before the deadline still succeeds.
        const pinned = await seeded({ deadline: now + 10 });
        expect(await repo.acceptIfOpen(pinned.intentId, "GSOLVER", now + 600, now)).toMatchObject({ state: "accepted" });
      });

      it("extendDeadlineIfAccepted never shortens a window", async () => {
        const intent = await seeded({ state: "accepted", solver: "GSOLVER", deadline: now + 500 });
        expect(await repo.extendDeadlineIfAccepted(intent.intentId, now + 100)).toBeNull();
        expect(await repo.extendDeadlineIfAccepted(intent.intentId, now + 500)).toBeNull();
        expect(await repo.extendDeadlineIfAccepted(intent.intentId, now + 900)).toMatchObject({ deadline: now + 900, version: 1 });
      });

      it("records slash metadata", async () => {
        const intent = await seeded({ state: "accepted", solver: "GSOLVER" });
        const slashed = asIntent(await repo.slashIfAccepted(intent.intentId, { slashedAt: now, slashReason: "missed" }));
        expect(slashed).toMatchObject({ slashedAt: now, slashReason: "missed" });
      });
    });

    describe("concurrency", () => {
      it("lets exactly one of N concurrent acceptIfOpen calls win", async () => {
        const intent = await seeded();
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) => repo.acceptIfOpen(intent.intentId, `GSOLVER_${i}`, now + 600)),
        );
        const winners = results.filter((r) => r && !isVersionConflict(r));
        expect(winners).toHaveLength(1);
        expect((await repo.findById(intent.intentId))!.version).toBe(1);
      });

      it("loses zero updates when N writers retry on VersionConflict", async () => {
        const intent = await seeded({ quotedDstAmount: "0" });
        const writers = 15;

        const increment = async (): Promise<void> => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const current = (await repo.findById(intent.intentId))!;
            const next = String(Number(current.quotedDstAmount) + 1);
            const result = await repo.update(intent.intentId, { quotedDstAmount: next }, current.version);
            if (!isVersionConflict(result)) return;
          }
          throw new Error("retry budget exhausted");
        };

        await Promise.all(Array.from({ length: writers }, increment));
        const final = (await repo.findById(intent.intentId))!;
        expect(final.quotedDstAmount).toBe(String(writers));
        expect(final.version).toBe(writers);
      });
    });

    describe("createIdempotent", () => {
      it("creates once and replays the winner for the same key", async () => {
        const key = uuidv4();
        const first = await repo.createIdempotent(makeIntent(), key, now - 60);
        const second = await repo.createIdempotent(makeIntent(), key, now - 60);
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.intent.intentId).toBe(first.intent.intentId);
        expect((await repo.findByIdempotencyKey(key, now - 60))!.intentId).toBe(first.intent.intentId);
      });

      it("collapses N concurrent creates with the same key onto one row", async () => {
        const key = uuidv4();
        const results = await Promise.all(
          Array.from({ length: 10 }, () => repo.createIdempotent(makeIntent(), key, now - 60)),
        );
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(new Set(results.map((r) => r.intent.intentId)).size).toBe(1);
      });

      it("releases a key whose intent is older than the replay window", async () => {
        const key = uuidv4();
        const old = await repo.createIdempotent(makeIntent({ createdAt: now - 1000 }), key, now - 2000);
        expect(await repo.findByIdempotencyKey(key, now - 60)).toBeUndefined();
        const fresh = await repo.createIdempotent(makeIntent(), key, now - 60);
        expect(fresh.created).toBe(true);
        expect(fresh.intent.intentId).not.toBe(old.intent.intentId);
      });
    });
  });
}
