import {
  DatasetKind,
  DatasetSchema,
  SchemaField,
  SchemaVersion,
} from "./datasets.types";

/**
 * Schema registry and versioning policy.
 *
 * Additive-by-default policy (see docs/rfcs/0001-public-anonymised-datasets.md):
 *
 *   - Adding a new *optional* field is an **additive** change → bump MINOR.
 *   - Removing, renaming, retyping, or tightening a field (optional → required)
 *     is a **breaking** change → bump MAJOR and reset MINOR to 0.
 *
 * Breaking changes never mutate a published schema in place; they create a new
 * schema id so existing consumers keep working against the old contract.
 */

/** The currently-published schema for every dataset kind (v1.0). */
export const DATASET_SCHEMAS: Record<DatasetKind, DatasetSchema> = {
  intents: {
    name: "intents",
    version: { major: 1, minor: 0 },
    fields: [
      { name: "intentId", type: "string" },
      { name: "user", type: "string", description: "Salted hash when anonymisation is enabled" },
      { name: "srcChain", type: "string" },
      { name: "srcToken", type: "string" },
      { name: "srcTokenSymbol", type: "string" },
      { name: "dstToken", type: "string" },
      { name: "dstTokenSymbol", type: "string" },
      { name: "srcAmount", type: "string" },
      { name: "minDstAmount", type: "string" },
      { name: "quotedDstAmount", type: "string", optional: true },
      { name: "solver", type: "string", optional: true },
      { name: "state", type: "string" },
      { name: "createdAt", type: "int64", description: "Unix epoch seconds" },
      { name: "deadline", type: "int64", description: "Unix epoch seconds" },
      { name: "filledAt", type: "int64", optional: true, description: "Unix epoch seconds" },
      { name: "fillAmount", type: "string", optional: true },
      { name: "feeAmount", type: "string", optional: true },
      { name: "txHash", type: "string", optional: true },
    ],
  },
  fills: {
    name: "fills",
    version: { major: 1, minor: 0 },
    fields: [
      { name: "intentId", type: "string" },
      { name: "solver", type: "string", optional: true },
      { name: "srcChain", type: "string" },
      { name: "dstToken", type: "string" },
      { name: "fillAmount", type: "string" },
      { name: "feeAmount", type: "string", optional: true },
      { name: "createdAt", type: "int64", description: "Unix epoch seconds" },
      { name: "filledAt", type: "int64", optional: true, description: "Unix epoch seconds" },
      { name: "txHash", type: "string", optional: true },
    ],
  },
  solver_stats: {
    name: "solver_stats",
    version: { major: 1, minor: 0 },
    fields: [
      { name: "address", type: "string", description: "Public solver identity — never hashed" },
      { name: "name", type: "string" },
      { name: "bondAmount", type: "string" },
      { name: "fillsCompleted", type: "int64" },
      { name: "fillsFailed", type: "int64" },
      { name: "totalVolume", type: "string" },
      { name: "avgFillTime", type: "int64" },
      { name: "isActive", type: "boolean" },
      { name: "registeredAt", type: "int64", description: "Unix epoch seconds" },
      { name: "lastActiveAt", type: "int64", description: "Unix epoch seconds" },
      { name: "supportedChains", type: "string", description: "Comma-separated chain ids" },
      { name: "supportedTokens", type: "string", description: "Comma-separated token symbols" },
    ],
  },
  fees: {
    name: "fees",
    version: { major: 1, minor: 0 },
    fields: [
      { name: "intentId", type: "string" },
      { name: "solver", type: "string", optional: true },
      { name: "srcChain", type: "string" },
      { name: "dstToken", type: "string" },
      { name: "feeAmount", type: "string" },
      { name: "filledAt", type: "int64", optional: true, description: "Unix epoch seconds" },
    ],
  },
};

/** Format a version as `major.minor`. */
export function formatVersion(version: SchemaVersion): string {
  return `${version.major}.${version.minor}`;
}

/** Format a schema as its stable id, e.g. `intents-v1.0`. */
export function schemaId(schema: DatasetSchema): string {
  return `${schema.name}-v${formatVersion(schema.version)}`;
}

export type SchemaChangeKind = "none" | "additive" | "breaking";

/**
 * Classify the difference between two field lists.
 *
 * - `none`     — identical field lists.
 * - `additive` — only new optional fields were added; existing fields unchanged.
 * - `breaking` — a field was removed, renamed, retyped, or made required.
 */
export function classifySchemaChange(
  oldFields: SchemaField[],
  newFields: SchemaField[],
): SchemaChangeKind {
  const oldByName = new Map(oldFields.map((f) => [f.name, f]));

  let sawAddition = false;

  for (const field of newFields) {
    const existing = oldByName.get(field.name);
    if (!existing) {
      // A brand-new field is only safe if it is optional.
      if (field.optional) {
        sawAddition = true;
        continue;
      }
      return "breaking";
    }

    // Existing field: type, or optionality tightening, is a break.
    if (existing.type !== field.type) return "breaking";
    if (!existing.optional && field.optional) {
      // Relaxing required → optional is additive-safe (a loosening).
      continue;
    }
    if (existing.optional && !field.optional) return "breaking";
  }

  // Any field present in the old list but missing from the new list is a removal.
  const newNames = new Set(newFields.map((f) => f.name));
  for (const oldField of oldFields) {
    if (!newNames.has(oldField.name)) return "breaking";
  }

  return sawAddition ? "additive" : "none";
}

/**
 * Compute the next schema version given an additive or breaking change.
 * `"none"` returns the current version unchanged.
 */
export function nextVersion(current: SchemaVersion, change: SchemaChangeKind): SchemaVersion {
  switch (change) {
    case "additive":
      return { major: current.major, minor: current.minor + 1 };
    case "breaking":
      return { major: current.major + 1, minor: 0 };
    case "none":
      return { ...current };
  }
}

/** The ordering of columns (and CSV header order) for a schema. */
export function fieldNames(schema: DatasetSchema): string[] {
  return schema.fields.map((f) => f.name);
}
