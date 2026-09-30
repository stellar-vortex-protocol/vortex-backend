import { InMemoryIntentsRepository } from "./intents.repository";
import type { Intent } from "./intents.types";
import { PrismaIntentsRepository } from "./prisma-intents.repository";

/** A fully-populated intent with overridable fields. */
function intent(overrides: Partial<Intent> & { intentId: string }): Intent {
  return {
    user: "GUSER1",
    srcChain: "stellar",
    srcToken: { address: "0xsrc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
    srcAmount: "1000000",
    dstToken: { contract: "CDST", symbol: "USDT", decimals: 7 },
    minDstAmount: "990000",
    state: "open",
    createdAt: 1_000,
    deadline: 2_000,
    usdValueAtCreate: 100,
    ...overrides,
  } as Intent;
}

/**
 * Build a repository containing exactly `intents`.
 *
 * The in-memory repository seeds demo data in its constructor, so the seeds
 * are cleared first — otherwise every assertion about totals would be counting
 * fixtures this test never added.
 */
function repoWith(intents: Intent[]): InMemoryIntentsRepository {
  const repo = new InMemoryIntentsRepository();
  for (const seed of repo.findAll()) repo.delete(seed.intentId);
  for (const i of intents) repo.save(i);
  return repo;
}

const A = intent({ intentId: "a", createdAt: 100, deadline: 900, usdValueAtCreate: 50, state: "open" });
const B = intent({ intentId: "b", createdAt: 200, deadline: 800, usdValueAtCreate: 150, state: "filled", solver: "GSOLVERX" });
const C = intent({
  intentId: "c",
  createdAt: 300,
  deadline: 700,
  usdValueAtCreate: 250,
  state: "open",
  srcChain: "ethereum",
  srcToken: { address: "0xeth", symbol: "DAI", name: "Dai", decimals: 18, chain: "ethereum" },
  dstToken: { contract: "CETH", symbol: "XLM", decimals: 7 },
  user: "GUSER2",
});

const ALL = [A, B, C];

describe("InMemoryIntentsRepository.search (#440)", () => {
  const repo = () => repoWith(ALL);

  describe("no filters", () => {
    it("returns everything, newest first by default", () => {
      const { intents, total } = repo().search({});
      expect(total).toBe(3);
      expect(intents.map((i) => i.intentId)).toEqual(["c", "b", "a"]);
    });

    it("defaults to a page size of 20", () => {
      const many = Array.from({ length: 25 }, (_, i) => intent({ intentId: `i${i}`, createdAt: i }));
      const { intents, total } = repoWith(many).search({});
      expect(total).toBe(25);
      expect(intents).toHaveLength(20);
    });
  });

  describe("filters", () => {
    it("filters by state", () => {
      const { intents, total } = repo().search({ state: "open" });
      expect(total).toBe(2);
      expect(intents.map((i) => i.intentId).sort()).toEqual(["a", "c"]);
    });

    it("filters by user, case-insensitively", () => {
      expect(repo().search({ user: "guser2" }).intents.map((i) => i.intentId)).toEqual(["c"]);
    });

    it("filters by source chain", () => {
      expect(repo().search({ chain: "ethereum" }).intents.map((i) => i.intentId)).toEqual(["c"]);
    });

    it("filters by solver", () => {
      const { intents, total } = repo().search({ solver: "gsolverx" });
      expect(total).toBe(1);
      expect(intents[0].intentId).toBe("b");
    });

    it("excludes intents with no solver when filtering by solver", () => {
      // A and C were never accepted, so a solver filter must not match them.
      expect(repo().search({ solver: "GSOLVERX" }).total).toBe(1);
    });

    it("filters by source token symbol, case-insensitively", () => {
      expect(repo().search({ srcToken: "dai" }).intents.map((i) => i.intentId)).toEqual(["c"]);
    });

    it("filters by destination token symbol, case-insensitively", () => {
      // Results keep the default created:desc order, so b (200) precedes a (100).
      expect(repo().search({ dstToken: "usdt" }).intents.map((i) => i.intentId)).toEqual(["b", "a"]);
    });
  });

  describe("USD value range", () => {
    it("applies the minimum inclusively", () => {
      const { intents, total } = repo().search({ minAmountUsd: 150 });
      expect(total).toBe(2);
      expect(intents.map((i) => i.intentId).sort()).toEqual(["b", "c"]);
    });

    it("applies the maximum inclusively", () => {
      expect(repo().search({ maxAmountUsd: 150 }).total).toBe(2);
    });

    it("applies both bounds together", () => {
      const { intents } = repo().search({ minAmountUsd: 100, maxAmountUsd: 200 });
      expect(intents.map((i) => i.intentId)).toEqual(["b"]);
    });

    it("returns nothing for an empty range", () => {
      expect(repo().search({ minAmountUsd: 1000, maxAmountUsd: 2000 }).total).toBe(0);
    });

    it("excludes intents with no recorded USD value from a value filter", () => {
      const unpriced = intent({ intentId: "unpriced", usdValueAtCreate: undefined });
      const r = repoWith([...ALL, unpriced]);
      // An intent created before pricing was available must not be treated as
      // $0 and silently matched by a minAmountUsd=0 query.
      expect(r.search({ minAmountUsd: 0 }).intents.map((i) => i.intentId)).not.toContain("unpriced");
    });
  });

  describe("creation time range", () => {
    it("applies createdFrom inclusively", () => {
      const { intents } = repo().search({ createdFrom: 200 });
      expect(intents.map((i) => i.intentId).sort()).toEqual(["b", "c"]);
    });

    it("applies createdTo inclusively", () => {
      const { intents } = repo().search({ createdTo: 200 });
      expect(intents.map((i) => i.intentId).sort()).toEqual(["a", "b"]);
    });

    it("applies both bounds together", () => {
      expect(repo().search({ createdFrom: 200, createdTo: 300 }).intents.map((i) => i.intentId).sort()).toEqual([
        "b",
        "c",
      ]);
    });
  });

  describe("combined filters", () => {
    it("intersects rather than unions", () => {
      const { intents, total } = repo().search({ state: "open", minAmountUsd: 200 });
      expect(total).toBe(1);
      expect(intents[0].intentId).toBe("c");
    });

    it("returns nothing when the filters cannot all be satisfied", () => {
      expect(repo().search({ state: "filled", chain: "ethereum" }).total).toBe(0);
    });
  });

  describe("sorting", () => {
    it("defaults to created:desc", () => {
      expect(repo().search({}).intents.map((i) => i.intentId)).toEqual(["c", "b", "a"]);
    });

    it("sorts by created ascending", () => {
      expect(repo().search({ sort: "created:asc" }).intents.map((i) => i.intentId)).toEqual(["a", "b", "c"]);
    });

    it("sorts by deadline descending", () => {
      expect(repo().search({ sort: "deadline:desc" }).intents.map((i) => i.intentId)).toEqual(["a", "b", "c"]);
    });

    it("sorts by deadline ascending", () => {
      expect(repo().search({ sort: "deadline:asc" }).intents.map((i) => i.intentId)).toEqual(["c", "b", "a"]);
    });

    it("sorts by USD value descending", () => {
      expect(repo().search({ sort: "usd:desc" }).intents.map((i) => i.intentId)).toEqual(["c", "b", "a"]);
    });

    it("sorts by USD value ascending", () => {
      expect(repo().search({ sort: "usd:asc" }).intents.map((i) => i.intentId)).toEqual(["a", "b", "c"]);
    });

    it("accepts a bare dimension and treats it as descending", () => {
      // "usd" with no direction must behave exactly like "usd:desc".
      expect(repo().search({ sort: "usd" }).intents.map((i) => i.intentId)).toEqual(
        repo().search({ sort: "usd:desc" }).intents.map((i) => i.intentId),
      );
    });
  });

  describe("pagination", () => {
    it("reports the unpaginated total alongside the page", () => {
      const { intents, total } = repo().search({ limit: 2 });
      expect(total).toBe(3);
      expect(intents).toHaveLength(2);
    });

    it("walks the whole result set with offset", () => {
      const first = repo().search({ limit: 2, offset: 0 });
      const second = repo().search({ limit: 2, offset: 2 });
      expect(first.intents.map((i) => i.intentId)).toEqual(["c", "b"]);
      expect(second.intents.map((i) => i.intentId)).toEqual(["a"]);
      // Total is the match count, not the page size.
      expect(second.total).toBe(3);
    });

    it("returns an empty page past the end without error", () => {
      const { intents, total } = repo().search({ offset: 100 });
      expect(intents).toEqual([]);
      expect(total).toBe(3);
    });

    it("paginates after filtering, not before", () => {
      const { intents, total } = repo().search({ state: "open", limit: 1, offset: 0 });
      expect(total).toBe(2);
      expect(intents.map((i) => i.intentId)).toEqual(["c"]);
    });
  });
});

describe("PrismaIntentsRepository.search (#440)", () => {
  /**
   * Capture the arguments the repository hands to Prisma, so these tests assert
   * the query the database will actually run — the part that decides whether
   * the new filters are index-backed or a sequential scan.
   */
  function makeRepo() {
    const prisma = {
      intent: {
        findMany: jest.fn(async (_args: Record<string, unknown>) => []),
        count: jest.fn(async (_args: Record<string, unknown>) => 0),
      },
    };
    const argsOf = (): Record<string, unknown> => prisma.intent.findMany.mock.calls[0][0];
    return {
      repo: new PrismaIntentsRepository(prisma as never),
      prisma,
      args: argsOf,
      /** The `where` passed to findMany. */
      where: () => argsOf().where as Record<string, unknown>,
      /** The `orderBy` passed to findMany. */
      orderBy: () => argsOf().orderBy,
    };
  }

  it("issues a single count and a single findMany", async () => {
    const h = makeRepo();
    await h.repo.search({ state: "open" });
    expect(h.prisma.intent.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.intent.count).toHaveBeenCalledTimes(1);
  });

  describe("scalar filters stay on the typed where clause", () => {
    // These must remain top-level `where` keys rather than being folded into a
    // raw fragment, because that is what lets Postgres match a composite index.
    it("translates a state filter", async () => {
      const h = makeRepo();
      await h.repo.search({ state: "filled" });
      expect(h.where()).toMatchObject({ state: "filled" });
    });

    it("translates a chain filter", async () => {
      const h = makeRepo();
      await h.repo.search({ chain: "ethereum" });
      expect(h.where()).toMatchObject({ srcChain: "ethereum" });
    });

    it("makes the user and solver filters case-insensitive", async () => {
      const h = makeRepo();
      await h.repo.search({ user: "GABC", solver: "GXYZ" });
      expect(h.where()).toMatchObject({
        user: { equals: "GABC", mode: "insensitive" },
        solver: { equals: "GXYZ", mode: "insensitive" },
      });
    });
  });

  describe("USD value range", () => {
    it("combines both bounds into one filter object", async () => {
      const h = makeRepo();
      await h.repo.search({ minAmountUsd: 10, maxAmountUsd: 20 });
      // A single { gte, lte } object is what a btree range scan can use; two
      // separate AND-ed conditions would force a bitmap intersection.
      expect(h.where()).toMatchObject({ usdValueAtCreate: { gte: 10, lte: 20 } });
    });

    it("emits only the bound that was supplied", async () => {
      const h = makeRepo();
      await h.repo.search({ minAmountUsd: 10 });
      // An open-ended range must not become `lte: 0`, which would exclude
      // every intent from the result.
      expect(h.where()).toMatchObject({ usdValueAtCreate: { gte: 10 } });
      expect((h.where().usdValueAtCreate as Record<string, unknown>).lte).toBeUndefined();
    });

    it("emits only the upper bound when that is all there is", async () => {
      const h = makeRepo();
      await h.repo.search({ maxAmountUsd: 99 });
      expect(h.where()).toMatchObject({ usdValueAtCreate: { lte: 99 } });
    });
  });

  describe("creation time range", () => {
    it("combines both bounds into one filter object", async () => {
      const h = makeRepo();
      await h.repo.search({ createdFrom: 100, createdTo: 200 });
      expect(h.where()).toMatchObject({ createdAt: { gte: 100, lte: 200 } });
    });

    it("emits only the supplied bound", async () => {
      const h = makeRepo();
      await h.repo.search({ createdFrom: 100 });
      expect(h.where()).toMatchObject({ createdAt: { gte: 100 } });
      expect((h.where().createdAt as Record<string, unknown>).lte).toBeUndefined();
    });
  });

  describe("token symbol filters", () => {
    it("uses a parameterised raw expression so the value cannot be injected", async () => {
      const h = makeRepo();
      await h.repo.search({ srcToken: "USDC" });
      const and = h.where().AND as { values: string[]; strings: string }[];
      expect(and).toBeDefined();
      const fragment = and.map((f) => f.strings).join("");
      // The symbol is bound as a parameter, never interpolated into SQL.
      expect(fragment).toContain("lower(src_token->>'symbol')");
      expect(fragment).not.toContain("USDC");
      expect(and.map((f) => f.values)).toEqual([["USDC"]]);
    });

    it("supports both source and destination symbols in one query", async () => {
      const h = makeRepo();
      await h.repo.search({ srcToken: "USDC", dstToken: "XLM" });
      const and = h.where().AND as { values: string[]; strings: string }[];
      const fragment = and.map((f) => f.strings).join("");
      expect(fragment).toContain("lower(src_token->>'symbol')");
      expect(fragment).toContain("lower(dst_token->>'symbol')");
      // One Prisma.sql fragment per filter, each carrying its own bound value.
      expect(and.map((f) => f.values)).toEqual([["USDC"], ["XLM"]]);
    });

    it("omits the raw fragment entirely when no token filter is used", async () => {
      const h = makeRepo();
      await h.repo.search({ state: "open" });
      expect(h.where().AND).toBeUndefined();
    });
  });

  describe("sorting", () => {
    it.each([
      ["created:desc", { createdAt: "desc" }],
      ["created:asc", { createdAt: "asc" }],
      ["deadline:desc", { deadline: "desc" }],
      ["deadline:asc", { deadline: "asc" }],
      ["usd:desc", { usdValueAtCreate: "desc" }],
      ["usd:asc", { usdValueAtCreate: "asc" }],
    ])("maps %s onto its column", async (sort, expected) => {
      const h = makeRepo();
      await h.repo.search({ sort });
      expect(h.orderBy()).toEqual(expected);
    });

    it("defaults to created:desc when no sort is given", async () => {
      const h = makeRepo();
      await h.repo.search({});
      expect(h.orderBy()).toEqual({ createdAt: "desc" });
    });

    it("falls back to created:desc for an unrecognised sort", async () => {
      // The DTO already rejects these with a 400; the repository is the last
      // line of defence and must not emit an orderBy on a non-indexed column.
      const h = makeRepo();
      await h.repo.search({ sort: "nonsense" });
      expect(h.orderBy()).toEqual({ createdAt: "desc" });
    });
  });

  describe("pagination", () => {
    it("paginates in the database with take/skip, not in memory", async () => {
      const h = makeRepo();
      await h.repo.search({ limit: 10, offset: 30 });
      expect(h.args().take).toBe(10);
      expect(h.args().skip).toBe(30);
    });

    it("applies the default page size when none is given", async () => {
      const h = makeRepo();
      await h.repo.search({});
      expect(h.args().take).toBe(20);
      expect(h.args().skip).toBe(0);
    });
  });

  it("counts with the same filter as the page query", async () => {
    const h = makeRepo();
    await h.repo.search({ state: "open", minAmountUsd: 5, limit: 5 });
    // A total computed from a different filter than the page would report a
    // count the client cannot reconcile with the rows it actually received.
    expect(h.prisma.intent.count).toHaveBeenCalledWith({ where: h.where() });
  });
});
