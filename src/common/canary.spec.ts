import { isCanaryIntent } from "./canary";

describe("isCanaryIntent", () => {
  const canary = new Set(["GCANARYUSER", "GCANARYSOLVER"]);

  it("tags intents whose user or solver is a registered canary address", () => {
    expect(isCanaryIntent({ user: "GCANARYUSER" }, canary)).toBe(true);
    expect(isCanaryIntent({ user: "GREAL", solver: "GCANARYSOLVER" }, canary)).toBe(true);
    expect(isCanaryIntent({ user: "GREAL", solver: "GREALSOLVER" }, canary)).toBe(false);
    expect(isCanaryIntent({ user: "GREAL" }, new Set())).toBe(false);
  });
});
