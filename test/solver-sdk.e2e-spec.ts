import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { messages, messagesV2, signAccept, signCancel, signEvmCancelIntent, signEvmCreateIntent, signFill, signMessage, signWsAuth, VortexWsClient, IntentEvent } from "../packages/solver-sdk/src";
import { privateKeyToAccount } from "viem/accounts";
import { signHs256Jwt } from "../src/common/jwt";
import { createWsTestApp, waitFor, WsTestApp } from "./utils/create-ws-test-app";

/**
 * Contract tests for @vortex/solver-sdk (issue #446): shared signing vectors
 * and the WS client (auth, reconnect + replay, resync) against the gateway.
 */
const vectors = JSON.parse(
  readFileSync(join(__dirname, "../packages/solver-sdk/test-vectors/signatures.json"), "utf8"),
);

describe("solver SDK signing vectors", () => {
  const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, vectors.seedByte));
  const { intentId, timestamp } = vectors;

  it("produces byte-identical messages and signatures", () => {
    const sdk: Record<string, string> = {
      accept: messages.accept(intentId, kp.publicKey()),
      fill: messages.fill(intentId, kp.publicKey()),
      cancel: messages.cancel(intentId),
      wsAuth: messages.wsAuth(kp.publicKey(), timestamp),
      register: messages.register(kp.publicKey()),
    };
    for (const v of vectors.vectors) {
      expect(sdk[v.kind]).toBe(v.message);
      expect(signMessage(kp, v.message)).toBe(v.signature);
    }
    const byKind = Object.fromEntries(vectors.vectors.map((v: { kind: string; signature: string }) => [v.kind, v.signature]));
    expect(signAccept(kp, intentId).signature).toBe(byKind.accept);
    expect(signFill(kp, intentId, "100").signature).toBe(byKind.fill);
    expect(signCancel(kp, intentId).signature).toBe(byKind.cancel);
    expect(signWsAuth(kp, timestamp).signature).toBe(byKind.wsAuth);

    const context = { ...vectors.v2Context };
    const v2Messages: Record<string, string> = {
      accept: messagesV2.accept(intentId, kp.publicKey(), context),
      fill: messagesV2.fill(intentId, kp.publicKey(), "1000", undefined, context),
      cancel: messagesV2.cancel(intentId, kp.publicKey(), context),
    };
    for (const vector of vectors.v2Vectors) {
      expect(v2Messages[vector.kind]).toBe(vector.message);
      expect(signMessage(kp, vector.message)).toBe(vector.signature);
    }
  });

  it("builds EIP-712 create and cancel request bodies for EVM accounts", async () => {
    const evmPrivateKey = `0x${"11".repeat(32)}` as `0x${string}`;
    const evmAccount = privateKeyToAccount(evmPrivateKey);
    const evmDomain = {
      chainId: 1,
      verifyingContract: "0x0000000000000000000000000000000000000001" as const,
    };
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const common = {
      user: evmAccount.address,
      srcTokenAddress: "0x0000000000000000000000000000000000000002" as const,
      srcTokenSymbol: "USDC",
      srcTokenDecimals: 6,
      srcAmount: "1000000",
      dstTokenContract: "CDLZFC3SYJYDZT7K67CG2ZMSVXTXRUWDCQ3NDADYQV67QX2PVJ6C6S6D",
      dstTokenSymbol: "USDC",
      dstTokenDecimals: 6,
      minDstAmount: "990000",
      deadline: expiresAt + 900,
      nonce: "0123456789abcdef0123456789abcdef",
      expiresAt,
    };
    const create = await signEvmCreateIntent(evmPrivateKey, evmDomain, common);
    const cancel = await signEvmCancelIntent(evmPrivateKey, evmDomain, intentId, common.nonce, expiresAt);

    expect(create.user).toBe(evmAccount.address);
    expect(create.signature).toMatch(/^0x(?:[0-9a-f]{2}){65}$/i);
    expect(cancel.user).toBe(evmAccount.address);
    expect(cancel.signature).toMatch(/^0x(?:[0-9a-f]{2}){65}$/i);
  });
});

describe("solver SDK WS client against the gateway (e2e)", () => {
  const solver = Keypair.random();
  const secret = "j".repeat(32);
  let t: WsTestApp;
  const clients: VortexWsClient[] = [];

  beforeAll(async () => {
    t = await createWsTestApp({
      config: { authJwtSecret: secret },
      solvers: { [solver.publicKey()]: { address: solver.publicKey(), isActive: true } },
    });
  }, 30_000);

  afterAll(async () => {
    clients.forEach((c) => c.close());
    await t.app.close();
  });

  function client(opts: Partial<ConstructorParameters<typeof VortexWsClient>[0]> = {}) {
    const c = new VortexWsClient({ url: t.url, reconnect: { initialMs: 50, maxMs: 200 }, ...opts });
    clients.push(c);
    const events: IntentEvent[] = [];
    c.on("event", (e) => events.push(e));
    c.on("error", () => undefined);
    return { c, events };
  }

  it("authenticates with a signed auth frame and with a JWT", async () => {
    const signed = client({ signAuth: () => signWsAuth(solver) });
    const viaJwt = client({ token: signHs256Jwt({ sub: solver.publicKey(), exp: Math.floor(Date.now() / 1000) + 60 }, secret) });
    const methods: Array<string | undefined> = [];
    signed.c.on("auth_ok", (a) => methods.push(a.method));
    viaJwt.c.on("auth_ok", (a) => methods.push(a.method));
    signed.c.connect();
    viaJwt.c.connect();
    await waitFor(() => methods.length === 2);
    expect(methods.sort()).toEqual(["jwt", "signature"]);
    signed.c.close();
    viaJwt.c.close();
  });

  it("reconnects and replays missed events in order without duplicates", async () => {
    const { c, events } = client();
    let opened = 0;
    c.on("open", () => opened++);
    c.connect();
    await waitFor(() => opened === 1);
    await new Promise((r) => setTimeout(r, 50));

    for (let i = 0; i < 5; i++) await t.gateway.broadcast({ type: "intent_created", i });
    await waitFor(() => events.length === 5);

    // Drop the connection server-side, keep broadcasting while it is down.
    const sockets = (t.gateway as unknown as { connections: Map<{ terminate(): void }, unknown> }).connections;
    for (const s of sockets.keys()) s.terminate();
    for (let i = 5; i < 12; i++) await t.gateway.broadcast({ type: "intent_created", i });

    await waitFor(() => events.length === 12, 10_000);
    expect(opened).toBeGreaterThanOrEqual(2);
    expect(events.map((e) => e.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const seqs = events.map((e) => e.seq);
    for (let k = 1; k < seqs.length; k++) expect(seqs[k]).toBe(seqs[k - 1] + 1);
    c.close();
  }, 20_000);

  it("emits resync_required when resuming beyond the replay buffer", async () => {
    for (let i = 0; i < 510; i++) await t.gateway.broadcast({ type: "intent_expired", i });
    const { c } = client({ resumeFrom: 1 });
    const resync: Array<{ oldestAvailableSeq: number }> = [];
    c.on("resync_required", (r) => resync.push(r));
    c.connect();
    await waitFor(() => resync.length === 1);
    expect(resync[0].oldestAvailableSeq).toBeGreaterThan(2);
    c.close();
  }, 20_000);
});
