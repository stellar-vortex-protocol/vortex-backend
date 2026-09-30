import { toCsv } from "./csv-exporter";
import { DatasetRow } from "./datasets.types";

const schema = {
  name: "fees" as const,
  version: { major: 1, minor: 0 },
  fields: [
    { name: "intentId", type: "string" as const },
    { name: "feeAmount", type: "string" as const },
    { name: "filledAt", type: "int64" as const, optional: true },
  ],
};

describe("toCsv", () => {
  it("emits a header row matching the schema column order", () => {
    const csv = toCsv(schema, []).toString("utf8");
    expect(csv).toBe("intentId,feeAmount,filledAt\n");
  });

  it("serialises rows in schema column order", () => {
    const rows: DatasetRow[] = [{ intentId: "a", feeAmount: "100", filledAt: 123 }];
    const csv = toCsv(schema, rows).toString("utf8");
    expect(csv).toBe("intentId,feeAmount,filledAt\na,100,123\n");
  });

  it("renders null optional values as empty fields", () => {
    const rows: DatasetRow[] = [{ intentId: "a", feeAmount: "100", filledAt: null }];
    expect(toCsv(schema, rows).toString("utf8")).toBe("intentId,feeAmount,filledAt\na,100,\n");
  });

  it("quotes fields containing commas", () => {
    const twoFields = {
      ...schema,
      fields: [
        { name: "intentId", type: "string" as const },
        { name: "feeAmount", type: "string" as const },
      ],
    };
    const csv = toCsv(twoFields, [{ intentId: "a,b", feeAmount: "100" }]).toString("utf8");
    expect(csv).toBe('intentId,feeAmount\n"a,b",100\n');
  });

  it("escapes embedded double quotes", () => {
    const twoFields = {
      ...schema,
      fields: [
        { name: "intentId", type: "string" as const },
        { name: "feeAmount", type: "string" as const },
      ],
    };
    const csv = toCsv(twoFields, [{ intentId: 'a"b', feeAmount: "1" }]).toString("utf8");
    expect(csv).toBe('intentId,feeAmount\n"a""b",1\n');
  });

  it("serialises booleans as true/false", () => {
    const boolSchema = {
      name: "solver_stats" as const,
      version: { major: 1, minor: 0 },
      fields: [{ name: "isActive", type: "boolean" as const }],
    };
    const csv = toCsv(boolSchema, [{ isActive: true }]).toString("utf8");
    expect(csv).toBe("isActive\ntrue\n");
  });

  it("produces a Buffer", () => {
    expect(Buffer.isBuffer(toCsv(schema, []))).toBe(true);
  });
});
