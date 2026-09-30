import {
  negotiateFromRequest,
  negotiateProtocol,
  parseProtocolHeader,
  selectWsSubprotocol,
  SUPPORTED_WS_PROTOCOLS,
  WS_CLOSE_UNSUPPORTED_PROTOCOL,
  WS_PROTOCOL_V1,
} from "./ws-protocol";

describe("parseProtocolHeader", () => {
  it("returns null when the header is absent", () => {
    expect(parseProtocolHeader(undefined)).toBeNull();
  });

  it("returns null for an empty header", () => {
    expect(parseProtocolHeader("")).toBeNull();
    expect(parseProtocolHeader("   ")).toBeNull();
    expect(parseProtocolHeader(",")).toBeNull();
  });

  it("splits and trims comma-separated tokens", () => {
    expect(parseProtocolHeader("vortex.v1, vortex.v2")).toEqual(["vortex.v1", "vortex.v2"]);
  });

  it("flattens the array form Node sometimes produces", () => {
    expect(parseProtocolHeader(["vortex.v1", "vortex.v2"])).toEqual(["vortex.v1", "vortex.v2"]);
  });
});

describe("negotiateProtocol", () => {
  it("defaults to v1 when the client offers no subprotocol (backwards compatible)", () => {
    const result = negotiateProtocol(undefined);
    expect(result).toEqual({
      ok: true,
      protocol: WS_PROTOCOL_V1,
      requested: [],
      defaulted: true,
    });
  });

  it("selects v1 when the client explicitly offers it", () => {
    const result = negotiateProtocol("vortex.v1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.protocol).toBe(WS_PROTOCOL_V1);
      expect(result.defaulted).toBe(false);
    }
  });

  it("selects v1 even when unknown versions are offered first", () => {
    const result = negotiateProtocol("vortex.v2, vortex.v1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.protocol).toBe(WS_PROTOCOL_V1);
  });

  it("rejects a connection that only offers unknown versions", () => {
    const result = negotiateProtocol("vortex.v2");
    expect(result).toEqual({ ok: false, requested: ["vortex.v2"] });
  });

  it("rejects unrelated subprotocols", () => {
    const result = negotiateProtocol("graphql-ws");
    expect(result.ok).toBe(false);
  });

  it("rejects a future minor of the same family that is not implemented", () => {
    const result = negotiateProtocol("vortex.v1.1");
    expect(result.ok).toBe(false);
  });
});

describe("selectWsSubprotocol (ws `handleProtocols` hook)", () => {
  it("returns v1 when it was offered", () => {
    expect(selectWsSubprotocol(new Set(["vortex.v1"]))).toBe(WS_PROTOCOL_V1);
  });

  it("returns v1 when it is offered alongside unknown versions", () => {
    expect(selectWsSubprotocol(new Set(["vortex.v2", "vortex.v1"]))).toBe(WS_PROTOCOL_V1);
  });

  it("echoes an offered token when only unknown versions were given", () => {
    // The handshake must complete (so the client can observe the close frame)
    // — handleConnection then closes it with 1002. A missing echo would make
    // the `ws` client fail the handshake itself with "Server sent no
    // subprotocol" and surface 1006 instead of 1002.
    expect(selectWsSubprotocol(new Set(["vortex.v2"]))).toBe("vortex.v2");
  });

  it("returns undefined for an empty set — ws never calls it then", () => {
    expect(selectWsSubprotocol(new Set<string>())).toBeUndefined();
  });
});

describe("negotiateFromRequest", () => {
  it("defaults to v1 when no request is available", () => {
    const result = negotiateFromRequest();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.protocol).toBe(WS_PROTOCOL_V1);
  });

  it("reads the lower-cased header Node normalises to", () => {
    const result = negotiateFromRequest({
      headers: { "sec-websocket-protocol": "vortex.v2" },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a request that carries no subprotocol header", () => {
    const result = negotiateFromRequest({ headers: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.defaulted).toBe(true);
  });
});

describe("protocol constants", () => {
  it("closes unsupported versions with WebSocket code 1002", () => {
    expect(WS_CLOSE_UNSUPPORTED_PROTOCOL).toBe(1002);
  });

  it("publishes every supported version", () => {
    expect(SUPPORTED_WS_PROTOCOLS).toContain(WS_PROTOCOL_V1);
    expect(WS_PROTOCOL_V1).toBe("vortex.v1");
  });
});
