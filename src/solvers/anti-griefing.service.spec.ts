import { ConfigService } from "@nestjs/config";
import { HttpStatus } from "@nestjs/common";
import {
  AntiGriefingException,
  AntiGriefingService,
  RecordOutcomeResult,
} from "./anti-griefing.service";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";

const SOLVER = "GSOLVER000000000000000000000000000000000000000000000000";
const OTHER = "GOTHER0000000000000000000000000000000000000000000000000";

type AntiGriefingConfig = AppConfig["antiGriefing"];

/** Defaults chosen so the tier ladder is easy to walk in a single test. */
const DEFAULTS: AntiGriefingConfig = {
  enabled: true,
  windowSeconds: 3600,
  minSamples: 10,
  thresholdRatio: 0.5,
  recoveryRatio: 0.2,
  cooldownSeconds: 300,
  concurrencyCap: 2,
  suspensionSeconds: 3600,
};

interface MetricsMock {
  incAntiGriefingAction: jest.Mock;
  incAntiGriefingBlocked: jest.Mock;
  setAntiGriefingRatio: jest.Mock;
  incAntiGriefingIncidentExcluded: jest.Mock;
}

function configService(overrides: Partial<AntiGriefingConfig> = {}) {
  const antiGriefing: AntiGriefingConfig = { ...DEFAULTS, ...overrides };
  return {
    get: jest.fn().mockReturnValue(antiGriefing),
  } as unknown as ConfigService<AppConfig, true>;
}

describe("AntiGriefingService (issue #453)", () => {
  let nowMs: number;
  let metrics: MetricsMock;
  let service: AntiGriefingService;

  /** Build a service whose clock is fully controlled by the test. */
  function build(overrides: Partial<AntiGriefingConfig> = {}): AntiGriefingService {
    const svc = new AntiGriefingService(
      configService(overrides),
      metrics as unknown as MetricsService,
    );
    const clock = svc as unknown as { now: () => number };
    jest.spyOn(clock, "now").mockImplementation(() => nowMs);
    return svc;
  }

  /** Intent ids must be unique per record: the service de-duplicates by id. */
  let seq = 0;

  function unfilled(
    svc: AntiGriefingService,
    count: number,
    chain = "ethereum",
    solver = SOLVER,
  ): RecordOutcomeResult[] {
    const results: RecordOutcomeResult[] = [];
    for (let i = 0; i < count; i++) {
      results.push(
        svc.recordOutcome(solver, {
          intentId: `unfilled-${++seq}`,
          chain,
          outcome: "unfilled",
        }),
      );
    }
    return results;
  }

  function filled(
    svc: AntiGriefingService,
    count: number,
    chain = "ethereum",
    solver = SOLVER,
  ): RecordOutcomeResult[] {
    const results: RecordOutcomeResult[] = [];
    for (let i = 0; i < count; i++) {
      results.push(
        svc.recordOutcome(solver, {
          intentId: `filled-${++seq}`,
          chain,
          outcome: "filled",
        }),
      );
    }
    return results;
  }

  /** Assert an accept is refused, and return the coded body it produced. */
  async function expectRefusal(
    svc: AntiGriefingService,
    code: string,
    openAccepts = 0,
  ): Promise<Record<string, unknown>> {
    let thrown: unknown;
    try {
      await svc.assertCanAccept(SOLVER, {
        intentId: "intent-under-test",
        openAccepts: async () => openAccepts,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AntiGriefingException);
    const body = (thrown as AntiGriefingException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe(code);
    return body;
  }

  beforeEach(() => {
    nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    metrics = {
      incAntiGriefingAction: jest.fn(),
      incAntiGriefingBlocked: jest.fn(),
      setAntiGriefingRatio: jest.fn(),
      incAntiGriefingIncidentExcluded: jest.fn(),
    };
    service = build();
  });

  // ── Fairness: honest solvers are untouched ─────────────────────────────────

  describe("honest solvers", () => {
    it("never blocks a solver whose accepts are filled", async () => {
      filled(service, 25);
      unfilled(service, 2);

      expect(service.getStatus(SOLVER).level).toBe(0);
      await expect(
        service.assertCanAccept(SOLVER, {
          intentId: "intent-under-test",
          openAccepts: async () => 40,
        }),
      ).resolves.toBeUndefined();
      expect(metrics.incAntiGriefingBlocked).not.toHaveBeenCalled();
    });

    it("reports a clean status for a solver it has never seen", () => {
      const status = service.getStatus(OTHER);
      expect(status).toMatchObject({
        solver: OTHER,
        level: 0,
        samples: 0,
        unfilledRatio: 0,
        concurrencyCap: null,
        suspended: false,
        cooldownUntil: null,
        reputationPenalty: 1,
      });
    });

    it("does not escalate while the sample floor is unmet", async () => {
      // 9 unfilled = ratio 1.0, but below ANTIGRIEFING_MIN_SAMPLES.
      unfilled(service, 9);

      expect(service.getStatus(SOLVER).level).toBe(0);
      await expect(
        service.assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 0 }),
      ).resolves.toBeUndefined();
    });

    it("does not escalate below the ratio threshold", async () => {
      // Fills first, then 10 unfilled: 10/30 ≈ 0.33, under the 0.5 threshold.
      filled(service, 20);
      unfilled(service, 10);

      expect(service.getStatus(SOLVER).level).toBe(0);
      await expect(
        service.assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 0 }),
      ).resolves.toBeUndefined();
    });

    it("keeps reputation at 1.0 for a solver with no tier", () => {
      filled(service, 30);
      expect(service.reputationPenalty(SOLVER)).toBe(1);
    });
  });

  // ── Escalation ladder ──────────────────────────────────────────────────────

  describe("a griefing solver", () => {
    it("escalates to a cooldown once the rolling ratio breaches the threshold", () => {
      const results = unfilled(service, 10);
      expect(results).toHaveLength(10);
      expect(results[9].recorded).toBe(true);

      const status = service.getStatus(SOLVER);
      expect(status.level).toBe(1);
      expect(status.unfilledRatio).toBe(1);
      expect(status.cooldownUntil).toBe(nowMs + 300_000);
      expect(metrics.incAntiGriefingAction).toHaveBeenCalledWith(SOLVER, "cooldown");
      expect(metrics.setAntiGriefingRatio).toHaveBeenCalledWith(SOLVER, 1);
    });

    it("refuses accepts during the cooldown with a 429 + ANTIGRIEFING_COOLDOWN", async () => {
      unfilled(service, 10);

      const body = await expectRefusal(service, "ANTIGRIEFING_COOLDOWN");
      expect(body.error).toContain("cooling down");
      expect(body.retryAfterSeconds).toBe(300);

      const thrown = await service
        .assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 0 })
        .then(
          () => null,
          (err: AntiGriefingException) => err,
        );
      expect(thrown?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(thrown?.retryAfterSeconds).toBe(300);
      expect(metrics.incAntiGriefingBlocked).toHaveBeenCalledWith("ANTIGRIEFING_COOLDOWN");
    });

    it("escalates to the concurrency cap after the cooldown lapses", async () => {
      unfilled(service, 10); // → tier 1 + cooldown

      nowMs += 301_000; // cooldown over
      await expect(
        service.assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 0 }),
      ).resolves.toBeUndefined();

      unfilled(service, 1); // still ratio 1.0 → tier 2
      const status = service.getStatus(SOLVER);
      expect(status.level).toBe(2);
      expect(status.concurrencyCap).toBe(2);
      expect(metrics.incAntiGriefingAction).toHaveBeenCalledWith(SOLVER, "concurrency_cap");
    });

    it("enforces the reduced concurrency cap only once tier 2 is reached", async () => {
      unfilled(service, 10);
      nowMs += 301_000;
      unfilled(service, 1); // tier 2, new cooldown
      nowMs += 301_000; // cooldown over

      const body = await expectRefusal(service, "ANTIGRIEFING_CONCURRENCY_LIMIT", 2);
      expect(body.concurrencyCap).toBe(2);
      expect(body.openAccepts).toBe(2);
      expect(metrics.incAntiGriefingBlocked).toHaveBeenCalledWith(
        "ANTIGRIEFING_CONCURRENCY_LIMIT",
      );

      // One slot still free → admitted.
      await expect(
        service.assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 1 }),
      ).resolves.toBeUndefined();
    });

    it("suspends at tier 3 and refuses with a 403 + ANTIGRIEFING_SUSPENDED", async () => {
      unfilled(service, 10);
      nowMs += 301_000;
      unfilled(service, 1); // tier 2
      nowMs += 301_000;
      unfilled(service, 1); // tier 3

      const status = service.getStatus(SOLVER);
      expect(status.level).toBe(3);
      expect(status.suspended).toBe(true);
      expect(status.suspendedUntil).toBe(nowMs + 3_600_000);
      expect(status.reputationPenalty).toBe(0.5);
      expect(metrics.incAntiGriefingAction).toHaveBeenCalledWith(SOLVER, "suspended");

      const body = await expectRefusal(service, "ANTIGRIEFING_SUSPENDED");
      expect(body.indefinite).toBe(false);

      const thrown = await service
        .assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 0 })
        .then(
          () => null,
          (err: AntiGriefingException) => err,
        );
      expect(thrown?.getStatus()).toBe(HttpStatus.FORBIDDEN);
    });

    it("lifts a time-boxed suspension when it lapses, keeping tier 3", async () => {
      unfilled(service, 10);
      nowMs += 301_000;
      unfilled(service, 1);
      nowMs += 301_000;
      unfilled(service, 1); // suspended until nowMs + 3600s

      nowMs += 3_601_000;
      await expect(
        service.assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 0 }),
      ).resolves.toBeUndefined();
      expect(service.getStatus(SOLVER).level).toBe(3);
    });

    it("re-suspends a lapsed tier-3 solver on its next unfilled accept", () => {
      // Short suspension so the ladder still fits inside the rolling window.
      const svc = build({ suspensionSeconds: 60 });
      unfilled(svc, 10);
      nowMs += 301_000;
      unfilled(svc, 1);
      nowMs += 301_000;
      unfilled(svc, 1); // tier 3, suspended for 60 s
      nowMs += 61_000; // suspension lapses

      unfilled(svc, 1);
      expect(svc.getStatus(SOLVER).suspended).toBe(true);
      expect(svc.getStatus(SOLVER).level).toBe(3);
    });

    it("steps a tier back down once fills pull the ratio into recovery", () => {
      unfilled(service, 10); // tier 1
      expect(service.getStatus(SOLVER).level).toBe(1);

      filled(service, 50); // 10 / 60 ≈ 0.17 ≤ recovery 0.2
      const status = service.getStatus(SOLVER);
      expect(status.level).toBe(0);
      expect(status.reputationPenalty).toBe(1);
      expect(service.getAudit({ solver: SOLVER })[0].action).toBe("recovered");
      expect(metrics.incAntiGriefingAction).toHaveBeenCalledWith(SOLVER, "recovered");
    });

    it("ignores a second record for the same intent (fill and sweep can both fire)", () => {
      const first = service.recordOutcome(SOLVER, {
        intentId: "dup",
        chain: "ethereum",
        outcome: "unfilled",
      });
      const second = service.recordOutcome(SOLVER, {
        intentId: "dup",
        chain: "ethereum",
        outcome: "filled",
      });

      expect(first.recorded).toBe(true);
      expect(second.recorded).toBe(false);
      expect(service.getStatus(SOLVER).samples).toBe(1);
    });

    it("forgets outcomes that age out of the rolling window", () => {
      unfilled(service, 10);
      expect(service.getStatus(SOLVER).level).toBe(1);

      nowMs += 3_600_001; // window is 3600 s
      expect(service.getStatus(SOLVER).samples).toBe(0);
      expect(service.getStatus(SOLVER).unfilledRatio).toBe(0);
    });

    it("applies the controls to the offending solver only", async () => {
      unfilled(service, 10);

      await expect(
        service.assertCanAccept(OTHER, { intentId: "i", openAccepts: async () => 0 }),
      ).resolves.toBeUndefined();
      expect(service.getStatus(OTHER).level).toBe(0);
    });
  });

  // ── Admin incident exclusions ──────────────────────────────────────────────

  describe("admin incident exclusions", () => {
    it("does not count failures that fall inside a chain incident", () => {
      service.beginIncident({ chain: "ethereum", reason: "RPC outage", actor: "ops" });

      const results = unfilled(service, 10);

      expect(results.every((r) => r.excluded && !r.recorded)).toBe(true);
      expect(service.getStatus(SOLVER).samples).toBe(0);
      expect(service.getStatus(SOLVER).level).toBe(0);
      expect(metrics.incAntiGriefingIncidentExcluded).toHaveBeenCalledTimes(10);
      expect(service.getAudit({ solver: SOLVER })[0].action).toBe("incident_excluded");
    });

    it("keeps counting failures on chains the incident does not cover", () => {
      service.beginIncident({ chain: "ethereum", reason: "RPC outage", actor: "ops" });

      const results = unfilled(service, 10, "base");

      expect(results.every((r) => r.recorded && !r.excluded)).toBe(true);
      expect(service.getStatus(SOLVER).samples).toBe(10);
      expect(service.getStatus(SOLVER).level).toBe(1);
    });

    it("covers every chain when the incident is declared without one", () => {
      service.beginIncident({ chain: null, reason: "sequencer outage", actor: "ops" });

      expect(unfilled(service, 5, "base")[0].excluded).toBe(true);
      expect(unfilled(service, 5, "stellar")[0].excluded).toBe(true);
      expect(service.getStatus(SOLVER).samples).toBe(0);
    });

    it("counts failures that occur after the incident closes", () => {
      service.beginIncident({ chain: "ethereum", reason: "RPC outage", actor: "ops" });
      expect(unfilled(service, 3)[0].excluded).toBe(true);

      const incident = service.endIncident(service.listIncidents()[0].id, { actor: "ops" });
      expect(incident?.endedAt).toBe(nowMs);

      nowMs += 1_000;
      const after = unfilled(service, 10);
      expect(after.every((r) => r.recorded && !r.excluded)).toBe(true);
      expect(service.getStatus(SOLVER).level).toBe(1);
    });

    it("honours an explicit excludeUntil so late-detected failures stay excused", () => {
      service.beginIncident({ chain: "ethereum", reason: "RPC outage", actor: "ops" });
      const openedAt = nowMs;

      // The sweep that detects the missed fill runs after the outage resolves.
      nowMs += 600_000;
      const incident = service.listIncidents()[0];
      service.endIncident(incident.id, { excludeUntil: openedAt + 60_000, actor: "ops" });

      nowMs += 60_000;
      const duringOutage = service.recordOutcome(SOLVER, {
        intentId: "late-1",
        chain: "ethereum",
        outcome: "unfilled",
        at: openedAt + 30_000,
      });
      expect(duringOutage.excluded).toBe(true);

      const afterOutage = service.recordOutcome(SOLVER, {
        intentId: "late-2",
        chain: "ethereum",
        outcome: "unfilled",
        at: openedAt + 120_000,
      });
      expect(afterOutage.recorded).toBe(true);
      expect(service.getStatus(SOLVER).samples).toBe(1);
    });

    it("lists and audits incident lifecycle actions", () => {
      const incident = service.beginIncident({ reason: "sequencer outage", actor: "ops" });
      expect(incident.chain).toBeNull();
      expect(service.listIncidents()).toHaveLength(1);

      service.endIncident(incident.id, { actor: "ops" });
      expect(service.endIncident(incident.id, { actor: "ops" })).toBeNull();
      expect(service.endIncident("incident-999")).toBeNull();

      const actions = service.getAudit().map((entry) => entry.action);
      expect(actions).toContain("incident_opened");
      expect(actions).toContain("incident_closed");
    });
  });

  // ── Audit, metrics and operator break-glass ────────────────────────────────

  describe("audit and operator controls", () => {
    it("audits every refusal with the error code and intent", async () => {
      unfilled(service, 10);
      await expectRefusal(service, "ANTIGRIEFING_COOLDOWN");

      const entry = service.getAudit({ solver: SOLVER }).find((e) => e.action === "blocked");
      expect(entry).toBeDefined();
      expect(entry?.intentId).toBe("intent-under-test");
      expect(entry?.reason).toContain("ANTIGRIEFING_COOLDOWN");
      expect(entry?.level).toBe(1);
    });

    it("audits the tier ladder in order", async () => {
      unfilled(service, 10);
      nowMs += 301_000;
      unfilled(service, 1);
      nowMs += 301_000;
      unfilled(service, 1);

      const ladder = service
        .getAudit({ solver: SOLVER })
        .map((e) => e.action)
        .filter((a) => a !== "blocked");
      expect(ladder).toEqual(["suspended", "concurrency_cap", "cooldown"]);
    });

    it("ranks statuses by tier so a dashboard can surface the worst offenders", () => {
      unfilled(service, 10);
      filled(service, 5, "stellar", OTHER);
      const statuses = service.getAllStatuses();
      expect(statuses[0].solver).toBe(SOLVER);
      expect(statuses).toHaveLength(2);
    });

    it("clears every control on an operator reset but keeps the evidence", async () => {
      unfilled(service, 10);
      expect(service.getStatus(SOLVER).level).toBe(1);

      const status = service.clear(SOLVER, "ops");
      expect(status.level).toBe(0);
      expect(service.getStatus(SOLVER).samples).toBe(10);
      await expect(
        service.assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 0 }),
      ).resolves.toBeUndefined();
      expect(service.getAudit({ solver: SOLVER })[0].action).toBe("manual_reset");
    });

    it("tracks state for a bounded number of solvers", () => {
      for (let i = 0; i < 20; i++) {
        filled(service, 1, "stellar", `G${i}`);
      }
      expect(service.getAllStatuses().length).toBe(20);
    });
  });

  // ── Configuration ──────────────────────────────────────────────────────────

  describe("configuration", () => {
    it("is a no-op when disabled", async () => {
      const disabled = build({ enabled: false });

      expect(disabled.recordOutcome(SOLVER, {
        intentId: "i",
        chain: "ethereum",
        outcome: "unfilled",
      })).toMatchObject({ recorded: false, level: 0 });

      await expect(
        disabled.assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 0 }),
      ).resolves.toBeUndefined();
      expect(disabled.reputationPenalty(SOLVER)).toBe(1);
    });

    it("honours a custom concurrency cap and sample floor", async () => {
      const strict = build({ minSamples: 4, concurrencyCap: 1, thresholdRatio: 0.5 });

      unfilled(strict, 4); // tier 1 with the lower floor
      expect(strict.getStatus(SOLVER).level).toBe(1);

      nowMs += 301_000;
      unfilled(strict, 1); // tier 2, cap 1
      nowMs += 301_000;

      await expectRefusal(strict, "ANTIGRIEFING_CONCURRENCY_LIMIT", 1);
      await expect(
        strict.assertCanAccept(SOLVER, { intentId: "i", openAccepts: async () => 0 }),
      ).resolves.toBeUndefined();
    });

    it("treats a suspension length of 0 as indefinite", async () => {
      const indefinite = build({ minSamples: 2, suspensionSeconds: 0 });

      unfilled(indefinite, 2);
      nowMs += 301_000;
      unfilled(indefinite, 1);
      nowMs += 301_000;
      unfilled(indefinite, 1); // tier 3, indefinite

      const body = await expectRefusal(indefinite, "ANTIGRIEFING_SUSPENDED");
      expect(body.indefinite).toBe(true);
      expect(body.suspendedUntil).toBeNull();

      nowMs += 30 * 24 * 3_600_000; // no amount of waiting lifts it
      await expectRefusal(indefinite, "ANTIGRIEFING_SUSPENDED");
    });

    it("keeps reporting a recovery ratio that would exceed the threshold from oscillating", async () => {
      // Misconfigured on purpose: recovery >= threshold. Escalation is
      // evaluated first, so the solver can never ping-pong between tiers.
      const misconfigured = build({ minSamples: 4, thresholdRatio: 0.5, recoveryRatio: 1 });

      unfilled(misconfigured, 4);
      expect(misconfigured.getStatus(SOLVER).level).toBe(1);

      filled(misconfigured, 40); // ratio 4/44 < threshold → still recovers down only once
      expect(misconfigured.getStatus(SOLVER).level).toBe(0);
    });
  });
});
