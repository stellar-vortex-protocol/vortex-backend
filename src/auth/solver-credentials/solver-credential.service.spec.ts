import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import type { AdminAuditService } from "../../admin/admin-audit.service";
import {
  InMemoryCredentialRevocationBus,
  type CredentialRevocationBus,
  type CredentialRevocationMessage,
} from "./credential-revocation.bus";
import {
  PrismaSolverCredentialsRepository,
  type SolverCredentialRecord,
} from "./prisma-solver-credentials.repository";
import { SolverCredentialService } from "./solver-credential.service";
import { SCOPE_REQUIREMENTS, SOLVER_SCOPES, scopeAllows } from "./solver-scopes";
import { hashCredential } from "../credential-hashing";

/**
 * In-memory repository standing in for the Prisma-backed one. It mirrors the
 * real contract (only the hash is stored, the prefix is the lookup handle) so
 * the service-level tests exercise genuine behaviour rather than mocks of it.
 */
class InMemoryCredentialRepo {
  readonly rows = new Map<string, SolverCredentialRecord>();
  private nextId = 1;

  async create(data: {
    credPrefix: string;
    credHash: string;
    solverAddress: string;
    scopes: string[];
    ipAllowlist: string[] | null;
    expiresAt: number | null;
  }): Promise<SolverCredentialRecord> {
    const record: SolverCredentialRecord = {
      id: `cred-${this.nextId++}`,
      credPrefix: data.credPrefix,
      credHash: data.credHash,
      solverAddress: data.solverAddress,
      scopes: data.scopes,
      ipAllowlist: data.ipAllowlist,
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: data.expiresAt,
      revokedAt: null,
      rotatedAt: null,
      lastUsedAt: null,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async findByPrefix(prefix: string): Promise<SolverCredentialRecord | null> {
    return [...this.rows.values()].find((r) => r.credPrefix === prefix) ?? null;
  }

  async findById(id: string): Promise<SolverCredentialRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async listBySolver(solverAddress: string): Promise<SolverCredentialRecord[]> {
    return [...this.rows.values()].filter((r) => r.solverAddress === solverAddress);
  }

  async revoke(id: string, nowSec: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.revokedAt = nowSec;
  }

  async markRotated(id: string, nowSec: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.rotatedAt = nowSec;
  }

  async disableAllForSolver(solverAddress: string, nowSec: number): Promise<number> {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.solverAddress === solverAddress && row.revokedAt === null) {
        row.revokedAt = nowSec;
        count += 1;
      }
    }
    return count;
  }

  async touchLastUsed(id: string, nowSec: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.lastUsedAt = nowSec;
  }
}

/** Recorded shape of an audit entry, narrowed to what the assertions read. */
interface RecordedAuditEntry {
  action?: string;
  target?: string;
  before?: unknown;
  after?: unknown;
}

function auditStub(): { service: AdminAuditService; entries: RecordedAuditEntry[] } {
  const entries: RecordedAuditEntry[] = [];
  return {
    entries,
    service: {
      record: jest.fn(async (e: RecordedAuditEntry) => {
        entries.push(e);
      }),
    } as unknown as AdminAuditService,
  };
}

function config(): ConfigService<AppConfig, true> {
  return { get: () => undefined } as unknown as ConfigService<AppConfig, true>;
}

interface Harness {
  service: SolverCredentialService;
  repo: InMemoryCredentialRepo;
  bus: InMemoryCredentialRevocationBus;
  audit: { service: AdminAuditService; entries: RecordedAuditEntry[] };
}

function makeService(bus: CredentialRevocationBus): Harness {
  const repo = new InMemoryCredentialRepo();
  const audit = auditStub();
  const service = new SolverCredentialService(
    repo as unknown as PrismaSolverCredentialsRepository,
    audit.service,
    config(),
    bus,
  );
  return { service, repo, bus: bus as InMemoryCredentialRevocationBus, audit };
}

const SOLVER = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZAOKV6LTOTSGVYZWLXW3ZRBMR5C5";

describe("SolverCredentialService (#443)", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeService(new InMemoryCredentialRevocationBus());
  });

  afterEach(async () => {
    await h.service.onModuleDestroy();
  });

  describe("creation", () => {
    it("returns the plaintext once and persists only its hash", async () => {
      const { record, plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });

      expect(plaintext).toHaveLength(43); // 32 random bytes, base64url
      // The persisted row must not be recoverable to the plaintext.
      expect(record.credHash).toBe(hashCredential(plaintext));
      expect(record.credHash).not.toContain(plaintext);
      expect(record.credPrefix).toBe(plaintext.slice(0, 8));
    });

    it("audits the creation without recording the secret", async () => {
      const { record, plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });

      const entry = h.audit.entries.find((e) => e.action === "solver-credential.create");
      expect(entry).toBeDefined();
      const serialised = JSON.stringify(entry);
      expect(serialised).toContain(record.credPrefix);
      expect(serialised).not.toContain(plaintext);
    });
  });

  describe("resolution — deny by default", () => {
    it("resolves a valid credential to a principal", async () => {
      const { record, plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read", "intents:read"],
      });

      const principal = await h.service.resolveCredential(plaintext);

      expect(principal).toEqual({
        credentialId: record.id,
        credPrefix: record.credPrefix,
        solverAddress: SOLVER,
        scopes: ["solver:read", "intents:read"],
        ipAllowlist: null,
      });
    });

    it("rejects an unknown prefix", async () => {
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });
      // Same secret, different leading 8 characters → different lookup handle.
      const forged = `ZZZZZZZZ${plaintext.slice(8)}`;

      expect(await h.service.resolveCredential(forged)).toBeNull();
    });

    it("rejects a wrong secret that shares a prefix", async () => {
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });
      const forged = `${plaintext.slice(0, 8)}${"A".repeat(plaintext.length - 8)}`;

      expect(await h.service.resolveCredential(forged)).toBeNull();
    });

    it("rejects a forged secret that reuses a live credential's prefix", async () => {
      // The prefix is a lookup handle, not a secret: it is returned in API
      // listings, audit rows and rate-limit trackers. An attacker who learns it
      // must still be unable to authenticate, so the stored hash has to be
      // checked on the way past the prefix lookup.
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });
      const forged = `${plaintext.slice(0, 8)}${"A".repeat(plaintext.length - 8)}`;

      expect(await h.service.resolveCredential(forged)).toBeNull();
    });

    it("rejects a forged secret on a warm cache too", async () => {
      // The cache is keyed by prefix, so a forged secret shares the real
      // credential's slot. The hash must be re-verified on the hit path,
      // otherwise a single successful resolution turns the cache into a bypass.
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });
      expect(await h.service.resolveCredential(plaintext)).not.toBeNull();
      expect(h.service.cacheSize).toBe(1);

      const forged = `${plaintext.slice(0, 8)}${"A".repeat(plaintext.length - 8)}`;
      expect(await h.service.resolveCredential(forged)).toBeNull();
      // ...and the genuine credential still works afterwards.
      expect(await h.service.resolveCredential(plaintext)).not.toBeNull();
    });

    it("does not let a forged secret poison the cache entry for the real one", async () => {
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });
      const forged = `${plaintext.slice(0, 8)}${"A".repeat(plaintext.length - 8)}`;

      // Forged first: it must be refused without leaving a cached record
      // behind that the genuine credential would then be checked against.
      expect(await h.service.resolveCredential(forged)).toBeNull();
      expect(await h.service.resolveCredential(plaintext)).not.toBeNull();
    });

    it("rejects a too-short credential without hitting the repository", async () => {
      const spy = jest.spyOn(h.repo, "findByPrefix");
      expect(await h.service.resolveCredential("short")).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it("rejects an empty credential", async () => {
      expect(await h.service.resolveCredential("")).toBeNull();
    });
  });

  describe("expiry", () => {
    it("resolves a credential that has not expired yet", async () => {
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      expect(await h.service.resolveCredential(plaintext)).not.toBeNull();
    });

    it("rejects a credential at or past its expiry", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
        expiresAt: nowSec - 1,
      });

      expect(await h.service.resolveCredential(plaintext)).toBeNull();
    });

    it("treats the expiry instant itself as expired", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
        expiresAt: nowSec,
      });

      // `expiresAt <= nowSec` is the rule: a credential is dead the moment it
      // reaches its expiry, not a second later.
      expect(await h.service.resolveCredential(plaintext, nowSec)).toBeNull();
    });

    it("never expires a credential created without an expiry", async () => {
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });

      const farFuture = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
      expect(await h.service.resolveCredential(plaintext, farFuture)).not.toBeNull();
    });
  });

  describe("scope enforcement matrix", () => {
    it("covers every declared scope as an operation", () => {
      for (const scope of SOLVER_SCOPES) {
        expect(SCOPE_REQUIREMENTS[scope]).toBe(scope);
      }
    });

    it.each(SOLVER_SCOPES.map((s) => [s] as const))(
      "allows a credential holding %s to perform that operation",
      (scope) => {
        expect(scopeAllows([scope], scope)).toBe(true);
      },
    );

    it.each(SOLVER_SCOPES.map((s) => [s] as const))(
      "denies a credential holding only %s every other operation",
      (scope) => {
        for (const operation of Object.keys(SCOPE_REQUIREMENTS)) {
          if (operation === scope) continue;
          expect(scopeAllows([scope], operation)).toBe(false);
        }
      },
    );

    it("denies an unknown operation", () => {
      expect(scopeAllows(["solver:read"], "intents:delete-everything")).toBe(false);
    });

    it("denies a credential with no scopes at all", () => {
      for (const operation of Object.keys(SCOPE_REQUIREMENTS)) {
        expect(scopeAllows([], operation)).toBe(false);
      }
    });

    it("denies a null principal regardless of its scopes", () => {
      expect(h.service.scopeAllows(null, "solver:read")).toBe(false);
    });

    it("grants only what a multi-scope credential actually holds", async () => {
      const { plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["intents:read", "quote:respond"],
      });
      const principal = await h.service.resolveCredential(plaintext);

      expect(h.service.scopeAllows(principal, "intents:read")).toBe(true);
      expect(h.service.scopeAllows(principal, "quote:respond")).toBe(true);
      // Read-only plus quoting: accepting and filling stay out of reach.
      expect(h.service.scopeAllows(principal, "intents:accept")).toBe(false);
      expect(h.service.scopeAllows(principal, "intents:fill")).toBe(false);
    });
  });

  describe("revocation", () => {
    it("stops resolving a revoked credential", async () => {
      const { record, plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });
      expect(await h.service.resolveCredential(plaintext)).not.toBeNull();

      await h.service.revokeCredential(record.id);

      expect(await h.service.resolveCredential(plaintext)).toBeNull();
    });

    it("is idempotent", async () => {
      const { record } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });

      await h.service.revokeCredential(record.id);
      await expect(h.service.revokeCredential(record.id)).resolves.toBeUndefined();
      expect(h.service.isRevoked(record.id)).toBe(true);
    });

    it("audits the revocation with its reason", async () => {
      const { record } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });

      await h.service.revokeCredential(record.id, "rotated");

      const entry = h.audit.entries.find((e) => e.action === "solver-credential.revoke");
      expect(entry).toBeDefined();
      expect(JSON.stringify(entry)).toContain("rotated");
    });

    it("invalidates the cache so a warm replica stops honouring it", async () => {
      const { record, plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });
      // Warm the cache.
      await h.service.resolveCredential(plaintext);
      expect(h.service.cacheSize).toBe(1);

      await h.service.revokeCredential(record.id);

      expect(h.service.cacheSize).toBe(0);
      expect(await h.service.resolveCredential(plaintext)).toBeNull();
    });
  });

  describe("rotation", () => {
    it("issues a new credential and revokes the old one", async () => {
      const { record, plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });

      const rotated = await h.service.rotateCredential(record.id);

      expect(rotated).not.toBeNull();
      expect(rotated!.plaintext).not.toBe(plaintext);
      // The replacement inherits the scopes and allowlist.
      expect(rotated!.record.scopes).toEqual(["solver:read"]);
      expect(rotated!.record.solverAddress).toBe(SOLVER);
    });

    it("makes the old credential unusable immediately", async () => {
      const { record, plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read"],
      });

      const rotated = await h.service.rotateCredential(record.id);

      expect(await h.service.resolveCredential(plaintext)).toBeNull();
      expect(await h.service.resolveCredential(rotated!.plaintext)).not.toBeNull();
    });

    it("keeps a working overlap for the replacement across the whole rotation", async () => {
      // Zero overlap would break a solver mid-rotation if the new credential is
      // not yet installed, so the replacement must be usable the instant it is
      // issued while the old one is dead.
      const { record, plaintext } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["intents:read", "intents:fill"],
      });

      const rotated = await h.service.rotateCredential(record.id);

      const oldPrincipal = await h.service.resolveCredential(plaintext);
      const newPrincipal = await h.service.resolveCredential(rotated!.plaintext);

      expect(oldPrincipal).toBeNull();
      expect(newPrincipal?.scopes).toEqual(["intents:read", "intents:fill"]);
      expect(h.service.scopeAllows(newPrincipal, "intents:fill")).toBe(true);
    });

    it("can narrow the scopes on rotation", async () => {
      const { record } = await h.service.createCredential({
        solverAddress: SOLVER,
        scopes: ["solver:read", "intents:fill"],
      });

      const rotated = await h.service.rotateCredential(record.id, ["solver:read"]);

      expect(rotated!.record.scopes).toEqual(["solver:read"]);
    });

    it("returns null for an unknown credential id", async () => {
      expect(await h.service.rotateCredential("does-not-exist")).toBeNull();
    });
  });

  describe("auto-disable on solver lifecycle events", () => {
    it("disables every active credential when a solver deregisters", async () => {
      const a = await h.service.createCredential({ solverAddress: SOLVER, scopes: ["solver:read"] });
      const b = await h.service.createCredential({ solverAddress: SOLVER, scopes: ["intents:read"] });

      const disabled = await h.service.disableAllForSolver(SOLVER);

      expect(disabled).toBe(2);
      expect(await h.service.resolveCredential(a.plaintext)).toBeNull();
      expect(await h.service.resolveCredential(b.plaintext)).toBeNull();
    });

    it("leaves other solvers' credentials untouched", async () => {
      const mine = await h.service.createCredential({ solverAddress: SOLVER, scopes: ["solver:read"] });
      const theirs = await h.service.createCredential({
        solverAddress: "GOTHEROTHEROTHEROTHEROTHEROTHEROTHEROTHEROTHEROTH",
        scopes: ["solver:read"],
      });

      await h.service.disableAllForSolver(SOLVER);

      expect(await h.service.resolveCredential(mine.plaintext)).toBeNull();
      expect(await h.service.resolveCredential(theirs.plaintext)).not.toBeNull();
    });

    it("does not double-count an already-revoked credential", async () => {
      const a = await h.service.createCredential({ solverAddress: SOLVER, scopes: ["solver:read"] });
      await h.service.createCredential({ solverAddress: SOLVER, scopes: ["solver:read"] });
      await h.service.revokeCredential(a.record.id);

      expect(await h.service.disableAllForSolver(SOLVER)).toBe(1);
    });

    it("returns 0 for a solver with no credentials", async () => {
      expect(await h.service.disableAllForSolver("GUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWNU")).toBe(0);
    });
  });
});

describe("credential revocation propagation across replicas (#443)", () => {
  /**
   * Two service instances sharing one bus, standing in for two replicas of the
   * deployment. The bus is the only thing they share, exactly as pub/sub is in
   * production.
   */
  function makeReplicaPair() {
    const bus = new InMemoryCredentialRevocationBus();
    const repo = new InMemoryCredentialRepo();
    const makeInstance = () =>
      new SolverCredentialService(
        repo as unknown as PrismaSolverCredentialsRepository,
        auditStub().service,
        config(),
        bus,
      );
    return { bus, repo, a: makeInstance(), b: makeInstance() };
  }

  it("propagates a revocation to another replica so it stops honouring the credential", async () => {
    const { repo, a, b } = makeReplicaPair();

    // Create on replica A, then warm the cache on BOTH replicas. If B has not
    // cached it, B would consult the database and deny for the wrong reason —
    // the point of the test is the cache invalidation, not the DB read.
    const { record, plaintext } = await a.createCredential({ solverAddress: SOLVER, scopes: ["solver:read"] });
    expect(await b.resolveCredential(plaintext)).not.toBeNull();
    expect(b.cacheSize).toBe(1);

    await a.revokeCredential(record.id);

    // B never re-read the row, yet the pub/sub message already invalidated it.
    expect(b.isRevoked(record.id)).toBe(true);
    expect(await b.resolveCredential(plaintext)).toBeNull();
    expect(repo.rows.get(record.id)?.revokedAt).not.toBeNull();
  });

  it("propagates a solver auto-disable to every replica", async () => {
    const { a, b } = makeReplicaPair();
    const { plaintext } = await a.createCredential({ solverAddress: SOLVER, scopes: ["solver:read"] });
    await b.resolveCredential(plaintext);

    await a.disableAllForSolver(SOLVER);

    expect(await b.resolveCredential(plaintext)).toBeNull();
  });

  it("propagates within the 5 second bound the issue requires", async () => {
    const { a, b } = makeReplicaPair();
    const { record, plaintext } = await a.createCredential({ solverAddress: SOLVER, scopes: ["solver:read"] });
    await b.resolveCredential(plaintext);

    const started = Date.now();
    await a.revokeCredential(record.id);
    const elapsed = Date.now() - started;

    expect(await b.resolveCredential(plaintext)).toBeNull();
    expect(elapsed).toBeLessThan(5_000);
  });

  it("denies on a replica that started AFTER the revocation, with no bus message", async () => {
    // A replica that boots mid-outage never receives the original message, so
    // the database must be authoritative on a cold cache.
    const bus = new InMemoryCredentialRevocationBus();
    const repo = new InMemoryCredentialRepo();
    const mk = () =>
      new SolverCredentialService(
        repo as unknown as PrismaSolverCredentialsRepository,
        auditStub().service,
        config(),
        bus,
      );

    const warm = mk();
    const { record, plaintext } = await warm.createCredential({ solverAddress: SOLVER, scopes: ["solver:read"] });
    await warm.revokeCredential(record.id);

    // A brand-new instance: empty revoked set, empty cache, same database.
    const late = mk();
    expect(late.cacheSize).toBe(0);
    expect(late.isRevoked(record.id)).toBe(false);
    // It must still refuse, because the row says revokedAt.
    expect(await late.resolveCredential(plaintext)).toBeNull();
  });

  it("keeps working when the bus publish fails", async () => {
    // A pub/sub outage must not prevent the local replica from denying.
    const brokenBus: CredentialRevocationBus = {
      publish: () => Promise.reject(new Error("redis pubsub down")),
      subscribe: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const h = makeService(brokenBus);
    const { record, plaintext } = await h.service.createCredential({
      solverAddress: SOLVER,
      scopes: ["solver:read"],
    });

    await expect(h.service.revokeCredential(record.id)).resolves.toBeUndefined();
    expect(await h.service.resolveCredential(plaintext)).toBeNull();
  });

  it("survives a bus message that is missing the cache-invalidation fields", async () => {
    // A truncated or older-format message must not throw inside the handler: an
    // exception there would silently unsubscribe the replica from every future
    // revocation. The credential id alone is still enough to deny.
    let deliver: ((msg: CredentialRevocationMessage) => void) | null = null;
    const bus: CredentialRevocationBus = {
      publish: () => Promise.resolve(),
      subscribe: (handler) => {
        deliver = handler;
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const h = makeService(bus);
    const { plaintext } = await h.service.createCredential({
      solverAddress: SOLVER,
      scopes: ["solver:read"],
    });
    await h.service.resolveCredential(plaintext);
    expect(h.service.cacheSize).toBe(1);

    expect(() =>
      deliver?.({ credentialId: "cred-1" } as unknown as CredentialRevocationMessage),
    ).not.toThrow();
    // No credPrefix to evict, so the cache entry survives — but the revoked id
    // is remembered, which is the part that actually blocks the credential.
    expect(h.service.isRevoked("cred-1")).toBe(true);
    expect(await h.service.resolveCredential(plaintext)).toBeNull();
  });
});
