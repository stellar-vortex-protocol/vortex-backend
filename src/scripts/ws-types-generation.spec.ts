import * as fs from "node:fs";
import * as path from "node:path";
import { generateWsTypes } from "../../scripts/generate-ws-types";

/**
 * The generated SDK types are committed, so the AsyncAPI document and
 * `src/generated/ws-api-types.ts` can drift apart the moment someone edits
 * `docs/asyncapi.yaml` without re-running the generator (issue #456).
 *
 * Runs in the "scripts" jest project (its tests live under `src/scripts/` but
 * import from `scripts/`, which needs the wider `tsconfig.scripts.json`).
 */
const SPEC_PATH = path.resolve(__dirname, "../../docs/asyncapi.yaml");
const GENERATED_PATH = path.resolve(__dirname, "../generated/ws-api-types.ts");

describe("generate-ws-types", () => {
  const yamlText = fs.readFileSync(SPEC_PATH, "utf8");

  it("keeps src/generated/ws-api-types.ts in sync with docs/asyncapi.yaml", () => {
    const expected = generateWsTypes(yamlText);
    const actual = fs.readFileSync(GENERATED_PATH, "utf8");

    expect(actual).toBe(expected);
  });

  it("is deterministic — regenerating twice yields identical output", () => {
    expect(generateWsTypes(yamlText)).toBe(generateWsTypes(yamlText));
  });

  it("emits every frame type as a named export", () => {
    const output = generateWsTypes(yamlText);

    for (const name of [
      "Connected",
      "Snapshot",
      "Subscribed",
      "SubscribeRejected",
      "ReplayStart",
      "ReplayEnd",
      "ReplayTooOld",
      "AuthOk",
      "AuthError",
      "EligibleSnapshot",
      "IntentCreated",
      "IntentAccepted",
      "IntentFilled",
      "IntentCancelled",
      "IntentExpired",
      "IntentSlashed",
      "ProtocolStatus",
      "SubscribeMessage",
      "ReplayMessage",
      "AuthMessage",
      "Intent",
      "WsServerFrame",
      "WsClientMessage",
    ]) {
      expect(output).toContain(name);
    }
  });

  it("marks the file as auto-generated with regeneration instructions", () => {
    const output = generateWsTypes(yamlText);
    expect(output).toContain("AUTO-GENERATED");
    expect(output).toContain("npm run generate:ws-types");
    expect(output).toContain("docs/asyncapi.yaml");
  });

  it("emits usable TypeScript (no unresolved refs left behind)", () => {
    const output = generateWsTypes(yamlText);

    // Every `$ref` target must exist as an emitted declaration.
    const refTargets = [...yamlText.matchAll(/\$ref:\s*"#\/components\/schemas\/([A-Za-z0-9_]+)"/g)].map(
      (match) => match[1],
    );
    for (const target of new Set(refTargets)) {
      expect(output).toMatch(new RegExp(`export (interface|type) ${target}\\b`));
    }
  });
});
