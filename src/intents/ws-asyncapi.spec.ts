/**
 * AsyncAPI schema validation (issue #456 — dev/test schema validation).
 *
 * Parses docs/asyncapi.yaml and validates that:
 * 1. The document is valid YAML.
 * 2. Required AsyncAPI 2.x top-level fields are present.
 * 3. Key message schemas match the shapes the gateway actually sends.
 *
 * This is intentionally lightweight — it does NOT pull in a full AsyncAPI
 * validation library (which would add a large devDependency and complicate
 * the test environment).  The goal is to catch schema drift between the
 * gateway implementation and the documented contract.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ── YAML load helper ────────────────────────────────────────────────────────

function loadAsyncApiSpec(): Record<string, unknown> {
  const candidates = [
    path.resolve(process.cwd(), "docs", "asyncapi.yaml"),
    path.resolve(__dirname, "..", "..", "docs", "asyncapi.yaml"),
    path.resolve(__dirname, "..", "..", "..", "docs", "asyncapi.yaml"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return yaml.load(raw) as Record<string, unknown>;
    }
  }
  throw new Error("docs/asyncapi.yaml not found from any candidate path");
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("docs/asyncapi.yaml — structure validation (issue #456)", () => {
  let spec: Record<string, unknown>;

  beforeAll(() => {
    spec = loadAsyncApiSpec();
  });

  it("is valid YAML and parses to an object", () => {
    expect(spec).toBeDefined();
    expect(typeof spec).toBe("object");
  });

  it("declares asyncapi version 2.x", () => {
    expect(typeof spec["asyncapi"]).toBe("string");
    expect((spec["asyncapi"] as string).startsWith("2.")).toBe(true);
  });

  it("has an info block with title and version", () => {
    const info = spec["info"] as Record<string, unknown>;
    expect(info).toBeDefined();
    expect(typeof info["title"]).toBe("string");
    expect(typeof info["version"]).toBe("string");
  });

  it("has at least one server defined", () => {
    const servers = spec["servers"] as Record<string, unknown>;
    expect(servers).toBeDefined();
    expect(Object.keys(servers).length).toBeGreaterThanOrEqual(1);
  });

  it("has a channels block", () => {
    expect(spec["channels"]).toBeDefined();
  });

  it("has a components.messages block", () => {
    const components = spec["components"] as Record<string, unknown>;
    expect(components).toBeDefined();
    const messages = components["messages"] as Record<string, unknown>;
    expect(messages).toBeDefined();
  });

  it("defines all expected server→client message types", () => {
    const components = spec["components"] as Record<string, unknown>;
    const messages = components["messages"] as Record<string, unknown>;
    const expected = [
      "connected",
      "snapshot",
      "intent_created",
      "intent_accepted",
      "intent_filled",
      "intent_cancelled",
      "intent_expired",
      "intent_slashed",
      "intent_tranche_reserved",
      "intent_partially_filled",
      "intent_tranche_slashed",
      "intent_destination_invalid",
      "replay_start",
      "replay_end",
      "replay_too_old",
      "auth_ok",
      "auth_error",
      "subscribed",
    ];
    for (const name of expected) {
      expect(messages[name]).toBeDefined();
    }
  });

  it("defines all expected client→server command types", () => {
    const components = spec["components"] as Record<string, unknown>;
    const messages = components["messages"] as Record<string, unknown>;
    const expected = ["subscribe_cmd", "auth_cmd", "replay_cmd"];
    for (const name of expected) {
      expect(messages[name]).toBeDefined();
    }
  });

  it("connected frame schema includes version field", () => {
    const components = spec["components"] as Record<string, unknown>;
    const schemas = components["schemas"] as Record<string, unknown>;
    const connectedSchema = schemas["ConnectedFrame"] as Record<string, unknown>;
    expect(connectedSchema).toBeDefined();
    const props = connectedSchema["properties"] as Record<string, unknown>;
    expect(props["version"]).toBeDefined();
  });

  it("intent_created frame schema requires intentId via Intent schema", () => {
    const components = spec["components"] as Record<string, unknown>;
    const schemas = components["schemas"] as Record<string, unknown>;
    const intentSchema = schemas["Intent"] as Record<string, unknown>;
    expect(intentSchema).toBeDefined();
    const required = intentSchema["required"] as string[];
    expect(required).toContain("intentId");
  });

  it("auth command requires solver, timestamp and signature", () => {
    const components = spec["components"] as Record<string, unknown>;
    const schemas = components["schemas"] as Record<string, unknown>;
    const authCmd = schemas["AuthCommand"] as Record<string, unknown>;
    expect(authCmd).toBeDefined();
    const required = authCmd["required"] as string[];
    expect(required).toContain("solver");
    expect(required).toContain("timestamp");
    expect(required).toContain("signature");
  });

  it("replay command requires fromSeq", () => {
    const components = spec["components"] as Record<string, unknown>;
    const schemas = components["schemas"] as Record<string, unknown>;
    const replayCmd = schemas["ReplayCommand"] as Record<string, unknown>;
    const required = replayCmd["required"] as string[];
    expect(required).toContain("fromSeq");
  });
});
