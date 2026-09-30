/**
 * scripts/generate-ws-types.ts
 *
 * Generates TypeScript types for the WebSocket protocol from
 * `docs/asyncapi.yaml` — the same "spec is the source of truth" flow that
 * `scripts/generate-client.ts` uses for the REST/OpenAPI surface (issue #456).
 *
 * Usage
 *   npm run generate:ws-types     # writes src/generated/ws-api-types.ts
 *
 * What it does
 *   1. Parses `docs/asyncapi.yaml` (the document served at `/docs/ws`).
 *   2. Emits one TypeScript declaration per entry in `components.schemas`
 *      (objects → `interface`, string enums → union types).
 *   3. Emits `WsServerFrame` / `WsClientMessage` unions derived from the two
 *      `operations` entries, so SDK consumers can type a frame stream without
 *      naming every frame.
 *
 * The generated file is committed; `src/scripts/ws-types-generation.spec.ts`
 * fails when it drifts from the YAML, so the spec and the types cannot
 * disagree.
 *
 * Issue #456
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

/** JSON-Shape of a single AsyncAPI/JSON-Schema object as used by this spec. */
export interface SchemaNode {
  $ref?: string;
  type?: string | string[];
  description?: string;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
}

export interface AsyncApiDocument {
  asyncapi: string;
  components?: {
    schemas?: Record<string, SchemaNode>;
    messages?: Record<string, { name?: string; payload?: SchemaNode }>;
  };
  channels?: Record<
    string,
    { messages?: Record<string, { $ref?: string }> }
  >;
  operations?: Record<
    string,
    { action?: string; messages?: Array<{ $ref?: string }> }
  >;
}

const SPEC_PATH = path.resolve(__dirname, "../docs/asyncapi.yaml");
const OUTPUT_PATH = path.resolve(__dirname, "../src/generated/ws-api-types.ts");

/** `#/components/schemas/Connected` → `Connected` */
function refName(ref: string): string {
  return ref.split("/").pop() as string;
}

/** TypeScript literal for one schema node. */
function tsType(node: SchemaNode): string {
  if (node.$ref) return refName(node.$ref);

  if (node.enum) {
    return node.enum
      .map((value) => (value === null ? "null" : typeof value === "string" ? JSON.stringify(value) : String(value)))
      .join(" | ");
  }

  if (Array.isArray(node.type)) {
    return node.type.map((one) => tsType({ ...node, type: one })).join(" | ");
  }

  switch (node.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = node.items ? tsType(node.items) : "unknown";
      return node.items && (node.items.enum || Array.isArray(node.items.type) || node.items.type === "array")
        ? `(${item})[]`
        : `${item}[]`;
    }
    case "object": {
      if (!node.properties) return "Record<string, unknown>";
      const entries = Object.entries(node.properties);
      const required = new Set(node.required ?? []);
      const body = entries.map(([key, child]) => `  ${key}${required.has(key) ? "" : "?"}: ${tsType(child)};`);
      return `{\n${body.join("\n")}\n}`;
    }
    default:
      return "unknown";
  }
}

function jsdoc(description: string | undefined, indent = ""): string[] {
  if (!description) return [];
  const lines = description.trim().split("\n").map((line) => `${indent} * ${line.trim()}`.trimEnd());
  return [`${indent}/**`, ...lines, `${indent} */`];
}

/** Emit one `components.schemas` entry. */
function emitSchema(name: string, node: SchemaNode): string[] {
  const out: string[] = [];

  // A bare enum (no object shape) becomes a union type.
  if (node.enum && !node.properties) {
    out.push(...jsdoc(node.description));
    out.push(`export type ${name} = ${tsType(node)};`);
    out.push("");
    return out;
  }

  if (node.properties) {
    out.push(...jsdoc(node.description));
    out.push(`export interface ${name} {`);
    const required = new Set(node.required ?? []);
    for (const [key, child] of Object.entries(node.properties)) {
      out.push(...jsdoc(child.description, "  "));
      out.push(`  ${key}${required.has(key) ? "" : "?"}: ${tsType(child)};`);
    }
    out.push("}");
    out.push("");
    return out;
  }

  out.push(...jsdoc(node.description));
  out.push(`export type ${name} = ${tsType(node)};`);
  out.push("");
  return out;
}

/** Resolve an operation message ref (`#/channels/…/messages/x`) to a payload schema name. */
function payloadNameForChannelMessage(
  doc: AsyncApiDocument,
  channelId: string,
  messageKey: string,
): string | null {
  const channel = doc.channels?.[channelId];
  const channelMessage = channel?.messages?.[messageKey]?.$ref;
  if (!channelMessage) return null;
  const messageKeyFromRef = refName(channelMessage);
  const message = doc.components?.messages?.[messageKeyFromRef];
  const payloadRef = message?.payload?.$ref;
  return payloadRef ? refName(payloadRef) : null;
}

/**
 * Build the full contents of `src/generated/ws-api-types.ts` from the YAML
 * text of `docs/asyncapi.yaml`.
 *
 * Exported so the drift test can regenerate and diff without touching disk.
 */
export function generateWsTypes(yamlText: string): string {
  const doc = parse(yamlText) as AsyncApiDocument;
  const schemas = doc.components?.schemas ?? {};
  const channels = Object.keys(doc.channels ?? {});
  const channelId = channels[0] ?? "";

  const lines: string[] = [
    "/**",
    " * AUTO-GENERATED — do not edit by hand.",
    " * Regenerate with: npm run generate:ws-types",
    " *",
    " * Source: docs/asyncapi.yaml (served live at GET /docs/ws).",
    " *",
    " * Usage:",
    " *   import type { WsServerFrame, IntentCreated } from './generated/ws-api-types';",
    " *",
    " * Issue #456",
    " */",
    "",
  ];

  for (const [name, node] of Object.entries(schemas)) {
    lines.push(...emitSchema(name, node));
  }

  const unionFor = (operationKey: string, exportName: string, docComment: string): void => {
    const operation = doc.operations?.[operationKey];
    const members = (operation?.messages ?? [])
      .map((message) => (message.$ref ? refName(message.$ref) : null))
      .filter((messageKey): messageKey is string => messageKey !== null)
      .map((messageKey) => payloadNameForChannelMessage(doc, channelId, messageKey))
      .filter((name): name is string => name !== null);
    if (members.length === 0) return;
    lines.push(`/** ${docComment} */`);
    lines.push(`export type ${exportName} =`);
    members.forEach((member, index) => {
      lines.push(`  | ${member}${index === members.length - 1 ? ";" : ""}`);
    });
    lines.push("");
  };

  unionFor(
    "sendToClient",
    "WsServerFrame",
    "Every frame the gateway may send to a client.",
  );
  unionFor(
    "receiveFromClient",
    "WsClientMessage",
    "Every message a client may send to the gateway.",
  );

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function main(): void {
  if (!fs.existsSync(SPEC_PATH)) {
    console.error(`❌  ${SPEC_PATH} not found.`);
    process.exit(1);
  }

  const yamlText = fs.readFileSync(SPEC_PATH, "utf8");
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, generateWsTypes(yamlText), "utf8");
  console.log(`✅  WS types → ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

// Only write the file when executed directly; importing this module (the
// drift test) must have no side effects.
if (typeof require !== "undefined" && require.main === module) {
  main();
}
