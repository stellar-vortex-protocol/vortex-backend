/**
 * Self-service abuse score / audit endpoints (issue #607).
 *
 * Tests:
 * - A correctly signed request for an address returns that address's data.
 * - A missing header returns 401.
 * - An expired nonce returns 401.
 * - A bad signature returns 401.
 * - A replay (nonce already consumed) returns 401.
 * - A valid signature for address A cannot retrieve address B's data.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { AbuseController } from "./abuse.controller";
import { AbuseScoreService } from "./abuse-score.service";
import { AllowlistService } from "./allowlist.service";
import { SignatureNonceService } from "../common/signature-nonce.service";

// ── Helpers ──────────────────────────────────────────────────────────────────

function sign(keypair: Keypair, message: string): string {
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
}

/** Build request headers for the self-service endpoints. */
function authHeaders(
  keypair: Keypair,
  opts: { address?: string; nonce?: string; expiresAt?: number } = {},
): Record<string, string> {
  const address = opts.address ?? keypair.publicKey();
  const nonce = opts.nonce ?? `nonce-${Math.random()}`;
  const expiresAt = opts.expiresAt ?? Math.floor(Date.now() / 1000) + 60;
  const message = `abuse-self-service:${address.toLowerCase()}:${nonce}:${expiresAt}`;
  return {
    "x-vortex-address": address,
    "x-vortex-signature": sign(keypair, message),
    "x-vortex-nonce": nonce,
    "x-vortex-expires-at": String(expiresAt),
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

function buildController(overrides: {
  getAuditHistory?: jest.Mock;
  getCachedScore?: jest.Mock;
  nonceConsume?: jest.Mock;
}): AbuseController {
  const scorer = {
    getAuditHistory: overrides.getAuditHistory ?? jest.fn().mockResolvedValue([]),
    getCachedScore: overrides.getCachedScore ?? jest.fn().mockResolvedValue(null),
  } as unknown as AbuseScoreService;

  const allowlist = {} as unknown as AllowlistService;

  const nonceConsume = overrides.nonceConsume ?? jest.fn().mockResolvedValue(true);
  const nonceService = { consume: nonceConsume } as unknown as SignatureNonceService;

  return new AbuseController(scorer, allowlist, nonceService);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AbuseController — self-service endpoints (issue #607)", () => {
  const userA = Keypair.random();
  const userB = Keypair.random();

  // ── GET /me/score ──────────────────────────────────────────────────────────

  describe("GET /me/score", () => {
    it("returns the score for the authenticated address", async () => {
      const getCachedScore = jest.fn().mockResolvedValue(42);
      const ctrl = buildController({ getCachedScore });

      const headers = authHeaders(userA);
      const result = await ctrl.getSelfScore(
        headers["x-vortex-address"],
        headers["x-vortex-signature"],
        headers["x-vortex-nonce"],
        headers["x-vortex-expires-at"],
      );

      expect(result.address).toBe(userA.publicKey().toLowerCase());
      expect(result.score).toBe(42);
      expect(getCachedScore).toHaveBeenCalledWith(userA.publicKey().toLowerCase());
    });

    it("throws 401 when headers are missing", async () => {
      const ctrl = buildController({});
      await expect(ctrl.getSelfScore(undefined, undefined, undefined, undefined)).rejects.toMatchObject({
        status: 401,
      });
    });

    it("throws 401 when the nonce has expired", async () => {
      const ctrl = buildController({});
      const expiresAt = Math.floor(Date.now() / 1000) - 200; // expired
      const headers = authHeaders(userA, { expiresAt });

      await expect(
        ctrl.getSelfScore(
          headers["x-vortex-address"],
          headers["x-vortex-signature"],
          headers["x-vortex-nonce"],
          headers["x-vortex-expires-at"],
        ),
      ).rejects.toMatchObject({ status: 401 });
    });

    it("throws 401 when the signature is invalid", async () => {
      const ctrl = buildController({});
      const headers = authHeaders(userA);
      // Corrupt the signature
      const badSig = Buffer.alloc(64).toString("base64");

      await expect(
        ctrl.getSelfScore(
          headers["x-vortex-address"],
          badSig,
          headers["x-vortex-nonce"],
          headers["x-vortex-expires-at"],
        ),
      ).rejects.toMatchObject({ status: 401 });
    });

    it("throws 401 when the nonce has already been used (replay prevention)", async () => {
      const nonceConsume = jest.fn().mockResolvedValue(false); // nonce already consumed
      const ctrl = buildController({ nonceConsume });

      const headers = authHeaders(userA);
      await expect(
        ctrl.getSelfScore(
          headers["x-vortex-address"],
          headers["x-vortex-signature"],
          headers["x-vortex-nonce"],
          headers["x-vortex-expires-at"],
        ),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  // ── GET /me/audit ──────────────────────────────────────────────────────────

  describe("GET /me/audit", () => {
    it("returns a reduced audit view (no raw IPs) for the authenticated address", async () => {
      const fullEvent = {
        timestamp: "2026-10-20T00:00:00.000Z",
        userAddress: userA.publicKey().toLowerCase(),
        clientIp: "203.0.113.5",
        operation: "create" as const,
        score: 80,
        action: "block" as const,
        signals: [{ signal: "rapid_intent", weight: 80, detail: "some detail" }],
        allowlisted: false,
      };
      const getAuditHistory = jest.fn().mockResolvedValue([fullEvent]);
      const ctrl = buildController({ getAuditHistory });

      const headers = authHeaders(userA);
      const result = await ctrl.getSelfAudit(
        undefined,
        headers["x-vortex-address"],
        headers["x-vortex-signature"],
        headers["x-vortex-nonce"],
        headers["x-vortex-expires-at"],
      );

      expect(result.address).toBe(userA.publicKey().toLowerCase());
      expect(result.events).toHaveLength(1);

      const event = result.events[0];
      // Reduced view includes timestamp, operation, action, signal names/weights.
      expect(event.timestamp).toBe(fullEvent.timestamp);
      expect(event.operation).toBe(fullEvent.operation);
      expect(event.action).toBe(fullEvent.action);
      expect(event.signals).toEqual([{ signal: "rapid_intent", weight: 80 }]);

      // Must NOT include raw IP or full admin-view fields.
      expect(Object.keys(event)).not.toContain("clientIp");
      expect(Object.keys(event)).not.toContain("score");
      expect(Object.keys(event)).not.toContain("allowlisted");
      expect(Object.keys(event)).not.toContain("userAddress");

      // Signal detail (internal note) must also be excluded.
      expect((event.signals[0] as Record<string, unknown>)["detail"]).toBeUndefined();
    });

    it("cannot retrieve address B's data using a valid signature for address A", async () => {
      const ctrl = buildController({});

      // Build correct headers for userA but swap in userB's address
      const nonce = `nonce-${Math.random()}`;
      const expiresAt = Math.floor(Date.now() / 1000) + 60;
      const message = `abuse-self-service:${userA.publicKey().toLowerCase()}:${nonce}:${expiresAt}`;
      const signatureForA = sign(userA, message);

      // Use userB's address but userA's signature — verification should fail.
      await expect(
        ctrl.getSelfAudit(
          undefined,
          userB.publicKey(),   // address = B
          signatureForA,       // signature = A
          nonce,
          String(expiresAt),
        ),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});

describe("AbuseController — replay protection with the real nonce store", () => {
  it("accepts a signed request once and rejects the identical replay", async () => {
    const user = Keypair.random();
    const scorer = {
      getCachedScore: jest.fn().mockResolvedValue(7),
      getAuditHistory: jest.fn().mockResolvedValue([]),
    } as unknown as AbuseScoreService;
    const nonces = new SignatureNonceService({} as never);
    const ctrl = new AbuseController(scorer, {} as AllowlistService, nonces);

    const h = authHeaders(user);
    const args = [h["x-vortex-address"], h["x-vortex-signature"], h["x-vortex-nonce"], h["x-vortex-expires-at"]] as const;

    await expect(ctrl.getSelfScore(...args)).resolves.toEqual({ address: user.publicKey().toLowerCase(), score: 7 });
    await expect(ctrl.getSelfScore(...args)).rejects.toMatchObject({ status: 401 });
  });

  it("does not burn the nonce when the signature is forged", async () => {
    const user = Keypair.random();
    const consume = jest.fn().mockResolvedValue(true);
    const ctrl = new AbuseController(
      { getCachedScore: jest.fn() } as unknown as AbuseScoreService,
      {} as AllowlistService,
      { consume } as unknown as SignatureNonceService,
    );
    const h = authHeaders(user);
    await expect(
      ctrl.getSelfScore(h["x-vortex-address"], Buffer.alloc(64).toString("base64"), h["x-vortex-nonce"], h["x-vortex-expires-at"]),
    ).rejects.toMatchObject({ status: 401 });
    expect(consume).not.toHaveBeenCalled();
  });
});
