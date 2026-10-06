/**
 * Performance budget for the simulation harness (issue #452):
 * replay 1M archived intents in under 5 minutes.
 *
 * The bound is asserted generously (300 s) because the issue's requirement
 * is the contract; local/CI runs are expected to land well below it. The
 * test measures `ReplayEngine.run` only — archive generation happens
 * before the clock starts.
 */
import { generateSyntheticArchive } from "./archive";
import { ReplayEngine } from "./engine";
import { AlwaysFillStrategy } from "./strategies/always-fill.strategy";

describe("replay performance (issue #452)", () => {
  it(
    "replays 1M intents in under 5 minutes",
    () => {
      const events = generateSyntheticArchive(1_000_000, 7);
      const engine = new ReplayEngine({
        strategy: new AlwaysFillStrategy(),
        params: { seed: 7 },
      });

      const started = Date.now();
      const report = engine.run(events);
      const elapsedMs = Date.now() - started;

      expect(report.totals.events).toBe(1_000_000);
      expect(report.totals.quotesSubmitted).toBe(1_000_000);
      expect(report.totals.filled).toBe(1_000_000);
      expect(report.totals.slashEvents).toBe(0);
      expect(elapsedMs).toBeLessThan(300_000);
    },
    300_000,
  );
});
