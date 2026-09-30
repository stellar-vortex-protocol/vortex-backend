import { DATASET_SCHEMAS, classifySchemaChange, nextVersion, schemaId } from "./schemas";
import { SchemaField } from "./datasets.types";

const base: SchemaField[] = [
  { name: "id", type: "string" },
  { name: "amount", type: "string" },
];

describe("classifySchemaChange", () => {
  it("returns 'none' for identical field lists", () => {
    expect(classifySchemaChange(base, base)).toBe("none");
  });

  it("returns 'additive' when a new optional field is appended", () => {
    const next: SchemaField[] = [...base, { name: "fee", type: "string", optional: true }];
    expect(classifySchemaChange(base, next)).toBe("additive");
  });

  it("returns 'additive' when multiple optional fields are appended", () => {
    const next: SchemaField[] = [
      ...base,
      { name: "fee", type: "string", optional: true },
      { name: "filledAt", type: "int64", optional: true },
    ];
    expect(classifySchemaChange(base, next)).toBe("additive");
  });

  it("returns 'breaking' when a new required field is added", () => {
    const next: SchemaField[] = [...base, { name: "fee", type: "string" }];
    expect(classifySchemaChange(base, next)).toBe("breaking");
  });

  it("returns 'breaking' when a field is removed", () => {
    expect(classifySchemaChange(base, [{ name: "id", type: "string" }])).toBe("breaking");
  });

  it("returns 'breaking' when a field is renamed", () => {
    const next: SchemaField[] = [
      { name: "identifier", type: "string" },
      { name: "amount", type: "string" },
    ];
    expect(classifySchemaChange(base, next)).toBe("breaking");
  });

  it("returns 'breaking' when a field is retyped", () => {
    const next: SchemaField[] = [
      { name: "id", type: "string" },
      { name: "amount", type: "int64" },
    ];
    expect(classifySchemaChange(base, next)).toBe("breaking");
  });

  it("returns 'breaking' when an optional field becomes required", () => {
    const withOptional: SchemaField[] = [...base, { name: "fee", type: "string", optional: true }];
    const tightened: SchemaField[] = [...base, { name: "fee", type: "string" }];
    expect(classifySchemaChange(withOptional, tightened)).toBe("breaking");
  });

  it("treats relaxing required → optional as non-breaking (a loosening)", () => {
    const relaxed: SchemaField[] = [
      { name: "id", type: "string" },
      { name: "amount", type: "string", optional: true },
    ];
    const change = classifySchemaChange(base, relaxed);
    expect(change).not.toBe("breaking");
  });
});

describe("nextVersion", () => {
  it("bumps minor on additive changes", () => {
    expect(nextVersion({ major: 1, minor: 0 }, "additive")).toEqual({ major: 1, minor: 1 });
  });

  it("bumps major and resets minor on breaking changes", () => {
    expect(nextVersion({ major: 1, minor: 4 }, "breaking")).toEqual({ major: 2, minor: 0 });
  });

  it("leaves version unchanged on 'none'", () => {
    expect(nextVersion({ major: 3, minor: 2 }, "none")).toEqual({ major: 3, minor: 2 });
  });
});

describe("schema registry", () => {
  it("registers a schema for every dataset kind", () => {
    for (const kind of ["intents", "fills", "solver_stats", "fees"] as const) {
      expect(DATASET_SCHEMAS[kind].name).toBe(kind);
      expect(DATASET_SCHEMAS[kind].fields.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate field names within a schema", () => {
    for (const schema of Object.values(DATASET_SCHEMAS)) {
      const names = schema.fields.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("formats stable schema ids", () => {
    expect(schemaId(DATASET_SCHEMAS.intents)).toBe("intents-v1.0");
  });

  it("treats the published schemas as the additive baseline for themselves", () => {
    for (const schema of Object.values(DATASET_SCHEMAS)) {
      expect(classifySchemaChange(schema.fields, schema.fields)).toBe("none");
    }
  });
});
