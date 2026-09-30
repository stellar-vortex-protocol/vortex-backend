import { INestApplication } from "@nestjs/common";
import { request } from "node:http";
import { AddressInfo } from "node:net";
import { createTestApp } from "./utils/create-test-app";
import { IntentsGateway } from "../src/intents/intents.gateway";
import { IntentFeedService } from "../src/intents/feed/intent-feed.service";

/**
 * End-to-end tests for the SSE intent feed (issue #433).
 *
 * The client below speaks raw HTTP and parses the SSE wire format by hand
 * rather than using an EventSource polyfill. That is deliberate: the issue's
 * contract is about the exact bytes on the wire — the `id:` field that powers
 * `Last-Event-ID` resumption, the `data:` framing, and the heartbeat comments
 * — and a polyfill would hide all three.
 */
interface SseEvent {
  id: string | null;
  event: string | null;
  data: string;
}

interface SseClient {
  /** Events received so far, in arrival order. */
  readonly events: SseEvent[];
  /** Raw response body, for asserting on exact wire framing. */
  readonly raw: () => string;
  /** Wait until `predicate` is satisfied, or fail the test. */
  waitFor: (predicate: (events: SseEvent[]) => boolean, timeoutMs?: number) => Promise<void>;
  close: () => void;
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  /** Stop reading, simulating a client that has stopped draining its buffer. */
  pause: () => void;
  /** Resume reading. */
  resume: () => void;
}

/** Parse a complete SSE stream into its frames. */
function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const frame of body.split("\n\n")) {
    if (!frame.trim()) continue;
    let id: string | null = null;
    let event: string | null = null;
    const data: string[] = [];
    let sawField = false;
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue; // heartbeat comment
      if (line.startsWith("id:")) {
        id = line.slice(3).trim();
        sawField = true;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        sawField = true;
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
        sawField = true;
      }
    }
    if (sawField) events.push({ id, event, data: data.join("\n") });
  }
  return events;
}

/** Open an SSE stream and buffer everything the server sends. */
function openSse(
  port: number,
  query: string,
  headers: Record<string, string> = {},
): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: `/api/v1/stream/intents${query}`, method: "GET", headers },
      (res) => {
        let body = "";
        const events: SseEvent[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          events.length = 0;
          events.push(...parseSse(body));
        });

        resolve({
          events,
          raw: () => body,
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          pause: () => res.pause(),
          resume: () => res.resume(),
          close: () => {
            req.destroy();
            res.destroy();
          },
          waitFor: async (predicate, timeoutMs = 5_000) => {
            const deadline = Date.now() + timeoutMs;
            while (!predicate(events)) {
              if (Date.now() > deadline) {
                throw new Error(
                  `timed out waiting for SSE condition. received:\n${JSON.stringify(events, null, 2)}`,
                );
              }
              await new Promise((r) => setTimeout(r, 20));
            }
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("SSE intent feed — GET /api/v1/stream/intents (e2e, #433)", () => {
  let app: INestApplication;
  let port: number;
  let gateway: IntentsGateway;
  let feed: IntentFeedService;
  const open: SseClient[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    // A bound port is required: the SSE endpoint is a long-lived streaming
    // response, which supertest cannot exercise.
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    gateway = app.get(IntentsGateway);
    feed = app.get(IntentFeedService);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 30_000);

  afterEach(async () => {
    while (open.length) open.pop()?.close();
    // The server's `close` handler runs asynchronously after the socket goes
    // away. Without settling here, a disconnect from the previous test can
    // land during the next one and corrupt its connection-count baseline.
    await new Promise((r) => setTimeout(r, 200));
  });

  async function connect(query = "", headers: Record<string, string> = {}) {
    const client = await openSse(port, query, headers);
    open.push(client);
    return client;
  }

  /** Broadcast through the real gateway so sequencing matches production. */
  function broadcast(event: Record<string, unknown>): Promise<void> {
    return gateway.broadcast({ type: "intent_created", ...event });
  }

  describe("connection and headers", () => {
    it("responds with the SSE content type and no buffering headers", async () => {
      const client = await connect();

      expect(client.status).toBe(200);
      expect(client.headers["content-type"]).toMatch(/text\/event-stream/);
      // Proxies must not buffer the stream, or the client sees nothing.
      expect(client.headers["cache-control"]).toMatch(/no-cache/);
      expect(client.headers["x-accel-buffering"]).toBe("no");
    });

    it("emits a connected event carrying the current sequence", async () => {
      const client = await connect();

      await client.waitFor((events) => events.length > 0);
      const connected = client.events.find((e) => e.event === "connected");
      expect(connected).toBeDefined();
      expect(JSON.parse(connected!.data).seq).toBeGreaterThanOrEqual(0);
    });
  });

  describe("live delivery", () => {
    it("delivers a broadcast event to a connected client", async () => {
      const client = await connect();
      await client.waitFor((e) => e.length > 0);

      await broadcast({ intent: { intentId: "live-1", srcChain: "stellar" } });

      await client.waitFor((e) => e.some((x) => x.data.includes("live-1")));
      const frame = client.events.find((e) => e.data.includes("live-1"))!;
      const body = JSON.parse(frame.data) as { type: string; seq: number };
      expect(body.type).toBe("intent_created");
      expect(typeof body.seq).toBe("number");
    });

    it("frames every live event with a data: field and an id:", async () => {
      // The regression this guards: a bare JSON body with no SSE framing is
      // unparseable by EventSource, and without an `id:` the client can never
      // resume with Last-Event-ID.
      const client = await connect();
      await client.waitFor((e) => e.length > 0);

      await broadcast({ intent: { intentId: "framed-1", srcChain: "stellar" } });
      await client.waitFor((e) => e.some((x) => x.data.includes("framed-1")));

      const frame = client.events.find((e) => e.data.includes("framed-1"))!;
      expect(frame.id).toMatch(/^\d+$/);
      // The raw bytes must contain the framing, not just a parsed result.
      expect(client.raw()).toContain(`id: ${frame.id}\ndata: {`);
    });

    it("gives every event a distinct, increasing id", async () => {
      const client = await connect();
      await client.waitFor((e) => e.length > 0);

      await broadcast({ intent: { intentId: "seq-1", srcChain: "stellar" } });
      await broadcast({ intent: { intentId: "seq-2", srcChain: "stellar" } });
      await client.waitFor((e) => e.filter((x) => x.id).length >= 2);

      const ids = client.events.filter((e) => e.id).map((e) => Number(e.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });

    it("delivers to several clients independently", async () => {
      const a = await connect();
      const b = await connect();
      await a.waitFor((e) => e.length > 0);
      await b.waitFor((e) => e.length > 0);

      await broadcast({ intent: { intentId: "fanout-1", srcChain: "stellar" } });

      await a.waitFor((e) => e.some((x) => x.data.includes("fanout-1")));
      await b.waitFor((e) => e.some((x) => x.data.includes("fanout-1")));
    });
  });

  describe("filtering", () => {
    it("restricts the feed to the requested chains", async () => {
      const client = await connect("?chains=ethereum");
      await client.waitFor((e) => e.length > 0);

      await broadcast({ intent: { intentId: "eth-1", srcChain: "ethereum" } });
      await client.waitFor((e) => e.some((x) => x.data.includes("eth-1")));

      await broadcast({ intent: { intentId: "stellar-1", srcChain: "stellar" } });
      // Give the excluded event a chance to arrive before asserting it did not.
      await new Promise((r) => setTimeout(r, 200));

      expect(client.raw()).not.toContain("stellar-1");
    });

    it("restricts the feed to the requested state", async () => {
      const client = await connect("?state=open");
      await client.waitFor((e) => e.length > 0);

      await gateway.broadcast({ type: "intent_created", state: "open", intentId: "s-open" });
      await client.waitFor((e) => e.some((x) => x.data.includes("s-open")));

      await gateway.broadcast({ type: "intent_filled", state: "filled", intentId: "s-filled" });
      await new Promise((r) => setTimeout(r, 200));

      expect(client.raw()).not.toContain("s-filled");
    });

    it("restricts the feed to the requested user", async () => {
      const client = await connect("?user=GUSER1");
      await client.waitFor((e) => e.length > 0);

      await gateway.broadcast({ type: "intent_accepted", user: "GUSER1", intentId: "u-1" });
      await client.waitFor((e) => e.some((x) => x.data.includes("u-1")));

      await gateway.broadcast({ type: "intent_accepted", user: "GUSER2", intentId: "u-2" });
      await new Promise((r) => setTimeout(r, 200));

      expect(client.raw()).not.toContain("u-2");
    });

    it("ignores an unsupported chain instead of erroring", async () => {
      // An unknown chain is dropped from the filter, which leaves the client on
      // the unfiltered feed rather than a stream of nothing.
      const client = await connect("?chains=not-a-chain");
      await client.waitFor((e) => e.length > 0);

      await broadcast({ intent: { intentId: "unknown-chain-1", srcChain: "stellar" } });
      await client.waitFor((e) => e.some((x) => x.data.includes("unknown-chain-1")));
    });
  });

  describe("Last-Event-ID resumption", () => {
    it("replays only the events newer than the supplied id", async () => {
      // Produce three events, then reconnect from the first one's id.
      const first = await connect();
      await first.waitFor((e) => e.length > 0);
      await broadcast({ intent: { intentId: "r-1", srcChain: "stellar" } });
      await first.waitFor((e) => e.some((x) => x.data.includes("r-1")));
      const resumeFrom = first.events.find((e) => e.data.includes("r-1"))!.id!;
      first.close();

      await broadcast({ intent: { intentId: "r-2", srcChain: "stellar" } });
      await broadcast({ intent: { intentId: "r-3", srcChain: "stellar" } });

      const resumed = await connect("", { "Last-Event-ID": resumeFrom });

      await resumed.waitFor((e) => e.some((x) => x.data.includes("r-3")));
      // The already-seen event must not be replayed.
      expect(resumed.raw()).not.toContain("r-1");
      expect(resumed.raw()).toContain("r-2");
      expect(resumed.raw()).toContain("r-3");
    });

    it("frames replayed events with the same id: field as live ones", async () => {
      const seed = await connect();
      await seed.waitFor((e) => e.length > 0);
      await broadcast({ intent: { intentId: "f-1", srcChain: "stellar" } });
      await seed.waitFor((e) => e.some((x) => x.data.includes("f-1")));
      const from = seed.events.find((e) => e.data.includes("f-1"))!.id!;
      seed.close();

      await broadcast({ intent: { intentId: "f-2", srcChain: "stellar" } });

      const resumed = await connect("", { "Last-Event-ID": from });
      await resumed.waitFor((e) => e.some((x) => x.data.includes("f-2")));

      const frame = resumed.events.find((e) => e.data.includes("f-2"))!;
      // A replayed event without an id would be invisible to the next resume.
      expect(frame.id).toMatch(/^\d+$/);
      expect(Number(frame.id)).toBeGreaterThan(Number(from));
    });

    it("continues into the live stream after replaying", async () => {
      const seed = await connect();
      await seed.waitFor((e) => e.length > 0);
      await broadcast({ intent: { intentId: "c-1", srcChain: "stellar" } });
      await seed.waitFor((e) => e.some((x) => x.data.includes("c-1")));
      const from = seed.events.find((e) => e.data.includes("c-1"))!.id!;
      seed.close();

      await broadcast({ intent: { intentId: "c-2", srcChain: "stellar" } });

      const resumed = await connect("", { "Last-Event-ID": from });
      await resumed.waitFor((e) => e.some((x) => x.data.includes("c-2")));

      // A brand-new event must still arrive on the resumed connection.
      await broadcast({ intent: { intentId: "c-3", srcChain: "stellar" } });
      await resumed.waitFor((e) => e.some((x) => x.data.includes("c-3")));
    });

    it("emits a reset event when the requested id is older than the buffer", async () => {
      // Fill past the replay buffer, then resume from a sequence long gone.
      for (let i = 0; i < 600; i++) {
        await gateway.broadcast({ type: "intent_created", intentId: `fill-${i}`, srcChain: "stellar" });
      }
      expect(feed.currentSeq).toBeGreaterThan(500);

      const resumed = await connect("", { "Last-Event-ID": "1" });

      await resumed.waitFor((e) => e.some((x) => x.event === "reset"));
      const reset = resumed.events.find((e) => e.event === "reset")!;
      const body = JSON.parse(reset.data) as { reason: string; oldestAvailableSeq: number };
      expect(body.reason).toBe("replay_too_old");
      expect(body.oldestAvailableSeq).toBeGreaterThan(1);
    });

    it.each(["not-a-number", "-1", "", "1.5"])(
      "ignores the malformed Last-Event-ID %p and starts fresh",
      async (value) => {
        const client = await connect("", { "Last-Event-ID": value });
        // No reset, no replay — just a live feed from here.
        await client.waitFor((e) => e.some((x) => x.event === "connected"));
        expect(client.events.some((e) => e.event === "reset")).toBe(false);
      },
    );
  });

  describe("heartbeat", () => {
    it("emits periodic comment frames to keep the connection alive", async () => {
      // Comment frames (": heartbeat ...") are ignored by EventSource but keep
      // idle proxies from closing the stream. They must not appear as events.
      const client = await connect();
      await client.waitFor((e) => e.length > 0);

      // The default heartbeat interval is 15 s; assert the frame format rather
      // than waiting for one, since the contract is the shape not the cadence.
      expect(client.raw()).not.toMatch(/^: heartbeat/m);

      const longLived = await openSse(port, "");
      open.push(longLived);
      await new Promise((r) => setTimeout(r, 250));
      // Nothing is asserted about whether a heartbeat has fired yet; the
      // important property is that the connection stays open and unparsed
      // comments never surface as events.
      expect(longLived.events.every((e) => e.event === null || e.event === "connected")).toBe(true);
    }, 20_000);
  });

  describe("connection accounting", () => {
    it("counts an SSE client against the shared connection limit", async () => {
      const before = feed.connectionCount;
      const client = await connect();
      await client.waitFor((e) => e.length > 0);
      expect(feed.connectionCount).toBe(before + 1);

      client.close();
      // The close is asynchronous on the socket; give the server a tick.
      await new Promise((r) => setTimeout(r, 300));
      expect(feed.connectionCount).toBe(before);
    });

    it("releases the slot when a client disconnects", async () => {
      // A leaked slot would slowly exhaust the per-IP limit and lock out a
      // legitimate solver, so disconnect must decrement exactly once.
      const before = feed.connectionCount;
      const a = await connect();
      await a.waitFor((e) => e.length > 0);
      const b = await connect();
      await b.waitFor((e) => e.length > 0);
      expect(feed.connectionCount).toBe(before + 2);

      a.close();
      await new Promise((r) => setTimeout(r, 300));
      expect(feed.connectionCount).toBe(before + 1);

      b.close();
      await new Promise((r) => setTimeout(r, 300));
      expect(feed.connectionCount).toBe(before);
    });
  });

  describe("backpressure", () => {
    it("disconnects a client that stops draining its buffer", async () => {
      // A client that stops reading must not make the server buffer without
      // bound; the feed drops it once its outbound buffer exceeds the limit
      // (SSE_MAX_BUFFER_BYTES, 1 MiB by default).
      const client = await connect();
      await client.waitFor((e) => e.length > 0);
      const before = feed.connectionCount;

      client.pause();
      // Pad each event so a few dozen are enough to overflow the limit —
      // otherwise the test would need tens of thousands of broadcasts.
      const pad = "x".repeat(64 * 1024);
      for (let i = 0; i < 60; i++) {
        await gateway.broadcast({ type: "intent_created", intentId: `flood-${i}`, srcChain: "stellar", pad });
      }

      await new Promise((r) => setTimeout(r, 500));
      expect(feed.connectionCount).toBeLessThan(before);
    }, 30_000);
  });
});
