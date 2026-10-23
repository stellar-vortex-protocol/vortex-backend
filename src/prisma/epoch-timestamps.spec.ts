import { dateToEpoch, epochToDate, readEpoch } from "./epoch-timestamps";

describe("epoch-timestamps (issue #409)", () => {
  it("converts epoch seconds to Date and back without loss", () => {
    for (const s of [0, 1_700_000_000, 2_147_483_647, 4_102_444_800 /* 2100, past the Int32 limit */]) {
      expect(dateToEpoch(epochToDate(s))).toBe(s);
    }
    expect(epochToDate(1_700_000_000).toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("floors sub-second Dates like floor(extract(epoch …)) in SQL", () => {
    expect(dateToEpoch(new Date("2023-11-14T22:13:20.999Z"))).toBe(1_700_000_000);
  });

  it("passes null/undefined through", () => {
    expect(epochToDate(null)).toBeNull();
    expect(epochToDate(undefined)).toBeNull();
    expect(dateToEpoch(null)).toBeNull();
  });

  it("reads from the selected column, falling back to the INTEGER column for un-backfilled rows", () => {
    const ts = new Date(1_800_000_000_000);
    expect(readEpoch("epoch", 1_700_000_000, ts)).toBe(1_700_000_000);
    expect(readEpoch("timestamptz", 1_700_000_000, ts)).toBe(1_800_000_000);
    expect(readEpoch("timestamptz", 1_700_000_000, null)).toBe(1_700_000_000);
    expect(readEpoch("timestamptz", null, null)).toBeNull();
  });
});
