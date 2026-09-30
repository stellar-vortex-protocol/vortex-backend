import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { ConnectionState, TokenBucket, resolveClientIp } from "./connection-state";
import { signHs256Jwt, verifyHs256Jwt } from "../../common/jwt";

/** Socket whose kernel buffer never drains: the slow-consumer worst case. */
function stuckSocket() {
  const sock = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent: 0,
    terminated: false,
    send(payload: string) {
      this.bufferedAmount += payload.length;
      this.sent++;
    },
    terminate() {
      this.terminated = true;
      this.readyState = 3;
    },
  });
  return sock;
}

describe("TokenBucket", () => {
  it("allows a burst then refills at the sustained rate", () => {
    const bucket = new TokenBucket(2, 3, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    expect(bucket.take(499)).toBe(false);
    expect(bucket.take(500)).toBe(true);
  });
});

describe("resolveClientIp", () => {
  it("ignores X-Forwarded-For unless proxies are trusted", () => {
    expect(resolveClientIp("10.0.0.2", "6.6.6.6", 0)).toBe("10.0.0.2");
    expect(resolveClientIp("10.0.0.2", "1.2.3.4", 1)).toBe("1.2.3.4");
    // A spoofed left-most entry is ignored when only the load balancer is trusted.
    expect(resolveClientIp("10.0.0.2", "6.6.6.6, 1.2.3.4", 1)).toBe("1.2.3.4");
    expect(resolveClientIp("10.0.0.2", "6.6.6.6, 1.2.3.4, 10.0.0.9", 2)).toBe("1.2.3.4");
    expect(resolveClientIp("10.0.0.2", "1.2.3.4", 5)).toBe("1.2.3.4");
  });
});

describe("ConnectionState outbound backpressure", () => {
  const payload = "x".repeat(1_000);

  it("keeps memory bounded for a consumer that never reads (drop_oldest)", () => {
    const sock = stuckSocket();
    const state = new ConnectionState(sock as unknown as WebSocket, "ip", { perSec: 1, burst: 1 }, {
      queueMax: 50,
      bufferBytes: 10_000,
      policy: "drop_oldest",
    });

    const results = Array.from({ length: 10_000 }, () => state.send(payload));

    expect(sock.bufferedAmount).toBeLessThanOrEqual(10_000 + payload.length);
    expect(state.queued()).toBe(50);
    expect(results.filter((r) => r === "dropped_oldest").length).toBe(10_000 - sock.sent - 50);
    expect(sock.terminated).toBe(false);
  });

  it("disconnects a slow consumer under the disconnect policy", () => {
    const sock = stuckSocket();
    const state = new ConnectionState(sock as unknown as WebSocket, "ip", { perSec: 1, burst: 1 }, {
      queueMax: 5,
      bufferBytes: 1_000,
      policy: "disconnect",
    });
    const results = Array.from({ length: 20 }, () => state.send(payload));
    expect(results).toContain("disconnected");
    expect(sock.terminated).toBe(true);
    expect(state.queued()).toBe(0);
  });
});

describe("HS256 JWT", () => {
  const secret = "s".repeat(32);

  it("verifies signature, expiry and subject", () => {
    const now = 1_000;
    const token = signHs256Jwt({ sub: "GSOLVER", exp: now + 60 }, secret);
    expect(verifyHs256Jwt(token, secret, now)?.sub).toBe("GSOLVER");
    expect(verifyHs256Jwt(token, "t".repeat(32), now)).toBeNull();
    expect(verifyHs256Jwt(token, secret, now + 61)).toBeNull();
    expect(verifyHs256Jwt(token.replace(/.$/, "A"), secret, now)).toBeNull();
    expect(verifyHs256Jwt(token, "", now)).toBeNull();
  });
});
