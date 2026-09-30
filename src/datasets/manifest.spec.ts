import { checksum, buildManifest } from "./manifest";
import { DATASET_SCHEMAS } from "./schemas";

describe("checksum", () => {
  it("computes a 64-char hex SHA-256 digest", () => {
    const digest = checksum(Buffer.from("hello world"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known SHA-256 of a fixed input", () => {
    // SHA-256("hello world") is a well-known constant.
    expect(checksum(Buffer.from("hello world"))).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("is deterministic for identical bytes", () => {
    const a = checksum(Buffer.from("payload"));
    const b = checksum(Buffer.from("payload"));
    expect(a).toBe(b);
  });

  it("differs for differing bytes", () => {
    expect(checksum(Buffer.from("payload"))).not.toBe(checksum(Buffer.from("payload2")));
  });
});

describe("buildManifest", () => {
  const schema = DATASET_SCHEMAS.intents;

  it("produces a manifest with the expected provenance fields", () => {
    const manifest = buildManifest({
      schema,
      date: "2026-09-28",
      revision: 1,
      generatedAt: new Date("2026-09-29T00:00:00.000Z"),
      watermark: new Date("2026-09-28T23:59:00.000Z"),
      rowCounts: { intents: 2, fills: 1, solver_stats: 3, fees: 1 },
      files: [{ format: "csv", kind: "intents", bytes: Buffer.from("a,b\n1,2\n") }],
    });

    expect(manifest.schema).toBe("intents-v1.0");
    expect(manifest.schemaVersion).toBe("1.0");
    expect(manifest.generatedAt).toBe("2026-09-29T00:00:00.000Z");
    expect(manifest.date).toBe("2026-09-28");
    expect(manifest.revision).toBe(1);
    expect(manifest.watermark).toBe("2026-09-28T23:59:00.000Z");
    expect(manifest.rowCounts.intents).toBe(2);
  });

  it("records the sha256, size, and row count for each file", () => {
    const bytes = Buffer.from("a,b\n1,2\n");
    const manifest = buildManifest({
      schema,
      date: "2026-09-28",
      revision: 1,
      generatedAt: new Date(),
      watermark: null,
      rowCounts: { intents: 2, fills: 0, solver_stats: 0, fees: 0 },
      files: [{ format: "csv", kind: "intents", bytes }],
    });

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].name).toBe("intents.csv");
    expect(manifest.files[0].format).toBe("csv");
    expect(manifest.files[0].rowCount).toBe(2);
    expect(manifest.files[0].sizeBytes).toBe(bytes.length);
    expect(manifest.files[0].sha256).toBe(checksum(bytes));
  });

  it("omits zero-row artifacts (null bytes) from files but keeps the row count", () => {
    const manifest = buildManifest({
      schema,
      date: "2026-09-28",
      revision: 1,
      generatedAt: new Date(),
      watermark: null,
      rowCounts: { intents: 0, fills: 0, solver_stats: 0, fees: 0 },
      files: [{ format: "parquet", kind: "intents", bytes: null }],
    });

    expect(manifest.files).toHaveLength(0);
    expect(manifest.rowCounts.intents).toBe(0);
  });

  it("uses a null watermark when no events are covered", () => {
    const manifest = buildManifest({
      schema,
      date: "2026-09-28",
      revision: 1,
      generatedAt: new Date(),
      watermark: null,
      rowCounts: { intents: 0, fills: 0, solver_stats: 0, fees: 0 },
      files: [],
    });
    expect(manifest.watermark).toBeNull();
  });
});
