/**
 * Sustained-block alerting (issue #604).
 *
 * Drives `AbuseScoreService.persistAudit` with `block` decisions against an
 * in-memory Redis stand-in that honours key TTLs, and checks that an alert
 * fires exactly once per actor per window.
 */

import { ConfigService } from "@nestjs/config";
import { AbuseScoreService } from "./abuse-score.service";
import { AbuseContext, AbuseScore } from "./abuse.types";
import type { AppConfig } from "../config/configuration";
import { captureAlert } from "../common/sentry";

jest.mock("../common/sentry", () => ({ captureAlert: jest.fn() }));

const mockCaptureAlert = captureAlert as jest.MockedFunction<typeof captureAlert>;

/** Redis stand-in covering the commands persistAudit uses, with TTL expiry on a mockable clock. */
class TtlFakeRedis {
  private readonly values = new Map<string, string>();
  private readonly expiresAt = new Map<string, number>();
  failing = false;

  on() {
    return this;
  }

  private sweep(key: string): void {
    const at = this.expiresAt.get(key);
    if (at !== undefined && at <= Date.now()) {
      this.values.delete(key);
      this.expiresAt.delete(key);
    }
  }

  incrSync(key: string): number {
    this.sweep(key);
    const next = Number(this.values.get(key) ?? "0") + 1;
    this.values.set(key, String(next));
    return next;
  }

  ttlSync(key: string): number {
    this.sweep(key);
    if (!this.values.has(key)) return -2;
    const at = this.expiresAt.get(key);
    return at === undefined ? -1 : Math.ceil((at - Date.now()) / 1000);
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.failing) throw new Error("Redis connection refused");
    this.expiresAt.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  pipeline() {
    const ops: Array<() => unknown> = [];
    const chain = {
      lpush: () => (ops.push(() => 1), chain),
      ltrim: () => (ops.push(() => "OK"), chain),
      expire: () => (ops.push(() => 1), chain),
      set: () => (ops.push(() => "OK"), chain),
      incr: (key: string) => (ops.push(() => this.incrSync(key)), chain),
      ttl: (key: string) => (ops.push(() => this.ttlSync(key)), chain),
      exec: async () => {
        if (this.failing) throw new Error("Redis connection refused");
        return ops.map((op) => [null, op()]);
      },
    };
    return chain;
  }

  disconnect() {}
}

const ctx: AbuseContext = {
  userAddress: "gattacker",
  clientIp: "203.0.113.7",
  srcAmount: "1",
  intentFingerprint: "ffff",
  operation: "create",
};

function decision(action: AbuseScore["action"]): AbuseScore {
  return {
    total: action === "block" ? 120 : 0,
    action,
    signals: [{ signal: "dust_intent", weight: 120, detail: "dust" }],
    actors: [],
    allowlisted: false,
  };
}

/** The private audit write path, reached directly so each test controls the decision. */
interface AuditWriter {
  persistAudit(c: AbuseContext, r: AbuseScore): Promise<void>;
}

function build(redis: TtlFakeRedis): AuditWriter {
  const config = { get: () => "redis://localhost:6379" } as unknown as ConfigService<AppConfig, true>;
  const svc = new AbuseScoreService(config);
  (svc as unknown as { redis: TtlFakeRedis }).redis = redis;
  return svc as unknown as AuditWriter;
}

/** Alerts raised so far for one actor key. */
function alertsFor(actor: string): number {
  return mockCaptureAlert.mock.calls.filter(([, c]) => c?.tags?.actor === actor).length;
}

describe("AbuseScoreService sustained-block alerting", () => {
  let now: number;
  let redis: TtlFakeRedis;

  beforeEach(() => {
    now = Date.UTC(2026, 9, 20);
    jest.spyOn(Date, "now").mockImplementation(() => now);
    mockCaptureAlert.mockReset();
    redis = new TtlFakeRedis();
    delete process.env.ABUSE_BLOCK_ALERT_THRESHOLD;
    delete process.env.ABUSE_BLOCK_ALERT_WINDOW_SECONDS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ABUSE_BLOCK_ALERT_THRESHOLD;
    delete process.env.ABUSE_BLOCK_ALERT_WINDOW_SECONDS;
  });

  it("does not alert below the default threshold of 5", async () => {
    const svc = build(redis);
    for (let i = 0; i < 4; i++) await svc.persistAudit(ctx, decision("block"));
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it("alerts exactly once per actor when the threshold is crossed inside the window", async () => {
    const svc = build(redis);
    for (let i = 0; i < 12; i++) {
      await svc.persistAudit(ctx, decision("block"));
      now += 10_000; // 12 blocks over 2 minutes, well inside 10 minutes
    }
    expect(alertsFor("user:gattacker")).toBe(1);
    expect(alertsFor("ip:203.0.113.7")).toBe(1);
  });

  it("references the existing audit endpoint and carries recent signals", async () => {
    const svc = build(redis);
    for (let i = 0; i < 5; i++) await svc.persistAudit(ctx, decision("block"));

    const [message, alert] = mockCaptureAlert.mock.calls.find(([, c]) => c?.tags?.actor === "user:gattacker")!;
    expect(message).toContain("user:gattacker blocked 5 times in 600s");
    expect(alert?.extra).toMatchObject({
      blockCount: 5,
      auditHistory: "/api/v1/abuse/audit/gattacker",
      signals: [{ signal: "dust_intent", weight: 120, detail: "dust" }],
    });
    expect(alert?.fingerprint).toEqual(["abuse_sustained_block", "user:gattacker"]);
  });

  it("does not alert when the blocks are spread across windows", async () => {
    const svc = build(redis);
    for (let i = 0; i < 10; i++) {
      await svc.persistAudit(ctx, decision("block"));
      now += 4 * 60_000; // one block every 4 minutes: never 5 inside 10 minutes
    }
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it("alerts again for a fresh crossing after the window expires", async () => {
    const svc = build(redis);
    for (let i = 0; i < 6; i++) await svc.persistAudit(ctx, decision("block"));
    expect(alertsFor("user:gattacker")).toBe(1);

    now += 601_000;
    for (let i = 0; i < 6; i++) await svc.persistAudit(ctx, decision("block"));
    expect(alertsFor("user:gattacker")).toBe(2);
  });

  it("ignores non-block decisions", async () => {
    const svc = build(redis);
    for (let i = 0; i < 10; i++) await svc.persistAudit(ctx, decision("throttle"));
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it("honours the env-configured threshold and window, and 0 disables alerting", async () => {
    process.env.ABUSE_BLOCK_ALERT_THRESHOLD = "2";
    process.env.ABUSE_BLOCK_ALERT_WINDOW_SECONDS = "30";
    const svc = build(redis);
    await svc.persistAudit(ctx, decision("block"));
    now += 31_000; // first block's window has closed
    await svc.persistAudit(ctx, decision("block"));
    expect(mockCaptureAlert).not.toHaveBeenCalled();
    await svc.persistAudit(ctx, decision("block"));
    expect(alertsFor("user:gattacker")).toBe(1);

    process.env.ABUSE_BLOCK_ALERT_THRESHOLD = "0";
    const disabled = build(new TtlFakeRedis());
    mockCaptureAlert.mockReset();
    for (let i = 0; i < 10; i++) await disabled.persistAudit(ctx, decision("block"));
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it("does not throw when alert delivery fails", async () => {
    mockCaptureAlert.mockImplementation(() => {
      throw new Error("sentry transport down");
    });
    const svc = build(redis);
    for (let i = 0; i < 5; i++) {
      await expect(svc.persistAudit(ctx, decision("block"))).resolves.toBeUndefined();
    }
    expect(mockCaptureAlert).toHaveBeenCalled();
  });

  it("does not throw when Redis is unavailable", async () => {
    redis.failing = true;
    const svc = build(redis);
    await expect(svc.persistAudit(ctx, decision("block"))).resolves.toBeUndefined();
    expect(mockCaptureAlert).not.toHaveBeenCalled();
  });

  it("the real captureAlert is a safe no-op when Sentry was never initialised", () => {
    const real = jest.requireActual<typeof import("../common/sentry")>("../common/sentry");
    expect(() => real.captureAlert("test alert", { tags: { actor: "user:x" } })).not.toThrow();
  });
});
