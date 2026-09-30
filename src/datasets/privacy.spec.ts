import { Anonymizer, deriveWindowSalt, hashAddress, windowIndexFor } from "./privacy";

describe("hashAddress", () => {
  it("is deterministic for a fixed (address, salt) pair", () => {
    expect(hashAddress("GABC", "salt")).toBe(hashAddress("GABC", "salt"));
  });

  it("differs across addresses for the same salt", () => {
    expect(hashAddress("GABC", "salt")).not.toBe(hashAddress("GDEF", "salt"));
  });

  it("differs across salts for the same address", () => {
    expect(hashAddress("GABC", "salt1")).not.toBe(hashAddress("GABC", "salt2"));
  });

  it("returns a 64-char hex digest", () => {
    expect(hashAddress("GABC", "salt")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveWindowSalt / windowIndexFor", () => {
  it("derives distinct salts for distinct window indices", () => {
    expect(deriveWindowSalt("base", 0)).not.toBe(deriveWindowSalt("base", 1));
  });

  it("places timestamps into the correct window", () => {
    const windowMs = 3_600_000; // 1 hour
    expect(windowIndexFor(0, windowMs)).toBe(0);
    expect(windowIndexFor(3_599_999, windowMs)).toBe(0);
    expect(windowIndexFor(3_600_000, windowMs)).toBe(1);
  });
});

describe("Anonymizer", () => {
  const base = "0123456789abcdef0123456789abcdef";

  it("hashes the same address identically within a rotation window", () => {
    const anon = new Anonymizer(base, 24, 2);
    const t1 = new Date("2026-09-28T10:00:00Z").getTime();
    const t2 = new Date("2026-09-28T11:00:00Z").getTime();
    expect(anon.hash("GABC", t1)).toBe(anon.hash("GABC", t2));
  });

  it("produces different hashes across rotation windows", () => {
    const anon = new Anonymizer(base, 24, 2);
    const t1 = new Date("2026-09-28T10:00:00Z").getTime();
    const t2 = new Date("2026-09-29T10:00:00Z").getTime();
    expect(anon.hash("GABC", t1)).not.toBe(anon.hash("GABC", t2));
  });

  it("does not leak the base salt in the digest", () => {
    const anon = new Anonymizer(base, 24, 2);
    const digest = anon.hash("GABC", Date.now());
    expect(digest).not.toContain(base);
  });

  it("does not expose the base salt through derived window salts", () => {
    const anon = new Anonymizer(base, 24, 2);
    const windowSalt = anon.saltFor(Date.now());
    expect(windowSalt).not.toContain(base);
  });
});
