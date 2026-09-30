import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import {
  clientMessageSchemaNames,
  clientMessageSchemas,
  serverFrameSchemaNames,
  serverFrameSchemas,
  validateClientMessage,
  validateServerFrame,
  wsValidationEnabled,
} from "./ws-schemas";

const SPEC_PATH = path.resolve(__dirname, "../../docs/asyncapi.yaml");

/** A fully-populated intent as it appears on the wire. */
const intent = {
  intentId: "11111111-2222-3333-4444-555555555555",
  user: "GE2ETESTUSER1234567",
  srcChain: "ethereum",
  srcToken: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    name: "USDC",
    decimals: 6,
    chain: "ethereum",
    priceUSD: 1,
  },
  srcAmount: "1000000",
  dstToken: {
    contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    symbol: "USDC",
    decimals: 7,
    priceUSD: 1,
  },
  minDstAmount: "990000",
  state: "open",
  createdAt: 1_700_000_000,
  deadline: 1_700_001_800,
};

describe("wsValidationEnabled", () => {
  const original = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it("is enabled in test/dev environments", () => {
    process.env.NODE_ENV = "test";
    expect(wsValidationEnabled()).toBe(true);
    process.env.NODE_ENV = "development";
    expect(wsValidationEnabled()).toBe(true);
  });

  it("is disabled in production", () => {
    process.env.NODE_ENV = "production";
    expect(wsValidationEnabled()).toBe(false);
  });

  it("treats an unset NODE_ENV as development", () => {
    delete process.env.NODE_ENV;
    expect(wsValidationEnabled()).toBe(true);
  });
});

describe("validateServerFrame", () => {
  it("accepts a well-formed control frame", () => {
    const result = validateServerFrame({
      type: "connected",
      message: "Vortex intent stream",
      seq: 0,
      protocol: "vortex.v1",
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts an intent_created frame with a full intent", () => {
    expect(
      validateServerFrame({ type: "intent_created", seq: 1, intent }),
    ).toEqual({ ok: true });
  });

  it("tolerates unknown fields on the intent payload", () => {
    const withExtra = { ...intent, somethingNew: true };
    expect(
      validateServerFrame({ type: "intent_created", seq: 1, intent: withExtra }).ok,
    ).toBe(true);
  });

  it("rejects a frame that is missing a required field", () => {
    const result = validateServerFrame({ type: "connected", message: "hi", seq: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("protocol");
  });

  it("rejects a frame with an undocumented extra field", () => {
    const result = validateServerFrame({
      type: "auth_ok",
      sneaky: true,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object frame", () => {
    expect(validateServerFrame("connected").ok).toBe(false);
    expect(validateServerFrame(null).ok).toBe(false);
    expect(validateServerFrame({ seq: 1 }).ok).toBe(false);
  });

  it("skips event types the gateway does not document", () => {
    expect(validateServerFrame({ type: "e1", seq: 1 })).toEqual({ ok: true, skipped: true });
  });

  it("accepts every frame shape the gateway is known to emit", () => {
    const frames: unknown[] = [
      { type: "connected", message: "Vortex intent stream", seq: 3, protocol: "vortex.v1" },
      { type: "snapshot", intents: [intent], seq: 3 },
      { type: "subscribed", filter: { chains: ["stellar"] } },
      { type: "subscribed", filter: { all: true } },
      { type: "subscribe_rejected", reason: "chains array may contain at most 20 values" },
      { type: "replay_start", fromSeq: 0, count: 2 },
      { type: "replay_end", count: 2 },
      { type: "replay_too_old", fromSeq: 0, oldestAvailableSeq: 5 },
      { type: "auth_ok" },
      { type: "auth_error", reason: "invalid solver signature" },
      { type: "eligible_snapshot", intents: [intent], count: 1 },
      { type: "intent_created", seq: 1, intent },
      { type: "intent_accepted", seq: 2, intentId: "abc", solver: "GABC" },
      { type: "intent_filled", seq: 3, intentId: "abc", solver: "GABC", fillAmount: "10" },
      { type: "intent_cancelled", seq: 4, intentId: "abc" },
      { type: "intent_expired", seq: 5, intentId: "abc" },
      { type: "intent_slashed", seq: 6, intentId: "abc", solver: "GABC", reason: "missed" },
      { type: "intent_slashed", seq: 7, intentId: "abc", reason: "missed" },
      {
        type: "protocol_status",
        seq: 8,
        action: "paused",
        scope: "chain",
        chain: "stellar",
        token: null,
        operation: null,
        reasonCode: "INCIDENT",
        reason: "incident",
        paused: true,
      },
    ];

    for (const frame of frames) {
      const result = validateServerFrame(frame);
      expect({ frame, result }).toEqual({ frame, result: { ok: true } });
    }
  });
});

describe("validateClientMessage", () => {
  it("accepts the documented client messages", () => {
    expect(validateClientMessage({ type: "subscribe", chains: ["stellar"] })).toEqual({ ok: true });
    expect(validateClientMessage({ type: "subscribe", all: true })).toEqual({ ok: true });
    expect(validateClientMessage({ type: "subscribe" })).toEqual({ ok: true });
    expect(validateClientMessage({ type: "replay", fromSeq: 12 })).toEqual({ ok: true });
    expect(
      validateClientMessage({
        type: "auth",
        solver: "GABC",
        timestamp: 1_700_000_000,
        signature: "base64==",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a replay without a cursor", () => {
    const result = validateClientMessage({ type: "replay" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("fromSeq");
  });

  it("rejects an auth message with the wrong field types", () => {
    const result = validateClientMessage({ type: "auth", solver: "GABC", timestamp: "now" });
    expect(result.ok).toBe(false);
  });

  it("rejects a subscribe with unexpected fields", () => {
    expect(validateClientMessage({ type: "subscribe", chain: "stellar" }).ok).toBe(false);
  });

  it("skips message types the gateway ignores by design", () => {
    expect(validateClientMessage({ type: "ping" })).toEqual({ ok: true, skipped: true });
    expect(validateClientMessage({ type: 42 })).toEqual({ ok: false, error: "message has no string `type` field" });
  });
});

describe("AsyncAPI document sync (docs/asyncapi.yaml)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spec: any;

  beforeAll(() => {
    spec = parse(fs.readFileSync(SPEC_PATH, "utf8"));
  });

  it("is a parseable AsyncAPI 3.0 document", () => {
    expect(spec.asyncapi).toBe("3.0.0");
    expect(spec.info.title).toBe("Vortex Intent Stream");
    expect(spec.channels.intentStream.address).toBe("/ws");
  });

  it("documents every server frame type the gateway can emit", () => {
    for (const [frameType, schemaName] of Object.entries(serverFrameSchemaNames)) {
      const schema = spec.components.schemas[schemaName];
      expect({ frameType, schema }).toEqual({ frameType, schema: expect.any(Object) });
      expect(schema.properties.type.enum).toEqual([frameType]);
    }
  });

  it("documents every client message the gateway handles", () => {
    for (const [messageType, schemaName] of Object.entries(clientMessageSchemaNames)) {
      const schema = spec.components.schemas[schemaName];
      expect({ messageType, schema }).toEqual({ messageType, schema: expect.any(Object) });
      expect(schema.properties.type.enum).toEqual([messageType]);
    }
  });

  it("has no documented frame that the runtime schemas do not know", () => {
    const registered = new Set<string>([
      ...Object.values(serverFrameSchemaNames),
      ...Object.values(clientMessageSchemaNames),
    ]);

    for (const [messageName, message] of Object.entries(spec.components.messages)) {
      const payloadRef = (message as { payload: { $ref: string } }).payload.$ref;
      const schemaName = payloadRef.split("/").pop() as string;
      expect({ messageName, schemaName, known: registered.has(schemaName) }).toEqual({
        messageName,
        schemaName,
        known: true,
      });
    }
  });

  it("wires both operations to the channel", () => {
    expect(spec.operations.sendToClient.action).toBe("send");
    expect(spec.operations.receiveFromClient.action).toBe("receive");
    expect(spec.operations.sendToClient.messages.length).toBe(
      Object.keys(serverFrameSchemaNames).length,
    );
    expect(spec.operations.receiveFromClient.messages.length).toBe(
      Object.keys(clientMessageSchemaNames).length,
    );
  });

  it("publishes the supported subprotocol on the server", () => {
    expect(spec.servers.vortex["x-vortex-subprotocols"]).toEqual(["vortex.v1"]);
  });

  it("keeps every registered schema name free of duplicates", () => {
    const all = [...Object.values(serverFrameSchemaNames), ...Object.values(clientMessageSchemaNames)];
    expect(new Set(all).size).toBe(all.length);
    expect(Object.keys(serverFrameSchemas).length).toBe(Object.keys(serverFrameSchemaNames).length);
    expect(Object.keys(clientMessageSchemas).length).toBe(Object.keys(clientMessageSchemaNames).length);
  });
});
