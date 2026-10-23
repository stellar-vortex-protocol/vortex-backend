/**
 * Destination preflight end-to-end (issue #439).
 *
 * Runs the real HTTP stack and the real Horizon reader against a local fake
 * Horizon server, so account / trustline responses are exactly the JSON
 * Horizon serves. Only the SAC → classic-asset lookup (a Soroban simulation)
 * is stubbed.
 */
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { AppConfig } from "../src/config/configuration";
import {
  DestinationPreflightService,
  HorizonSorobanLedgerReader,
} from "../src/soroban/destination-preflight.service";
import { buildAcceptMessage } from "../src/common/stellar-signature";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** Account id → Horizon `GET /accounts/{id}` body. Absent = 404. */
const horizonAccounts = new Map<string, unknown>();

function horizonAccount(id: string, trustline?: { limit: string; balance?: string; authorized?: boolean }) {
  horizonAccounts.set(id, {
    id,
    account_id: id,
    sequence: "1",
    balances: [
      ...(trustline
        ? [
            {
              balance: trustline.balance ?? "0.0000000",
              limit: trustline.limit,
              buying_liabilities: "0.0000000",
              selling_liabilities: "0.0000000",
              is_authorized: trustline.authorized ?? true,
              is_authorized_to_maintain_liabilities: trustline.authorized ?? true,
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: USDC_ISSUER,
            },
          ]
        : []),
      { balance: "100.0000000", asset_type: "native" },
    ],
  });
}

describe("Destination preflight (e2e, mocked Horizon)", () => {
  let app: INestApplication;
  let horizon: Server;

  beforeAll(async () => {
    horizon = createServer((req, res) => {
      const match = /^\/accounts\/([A-Z0-9]+)$/.exec(req.url ?? "");
      const body = match ? horizonAccounts.get(match[1]) : undefined;
      if (!body) {
        res.writeHead(404, { "content-type": "application/problem+json" });
        res.end(JSON.stringify({ type: "https://stellar.org/horizon-errors/not_found", status: 404 }));
        return;
      }
      res.writeHead(200, { "content-type": "application/hal+json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => horizon.listen(0, "127.0.0.1", resolve));
    const horizonUrl = `http://127.0.0.1:${(horizon.address() as AddressInfo).port}`;

    app = await createTestApp((builder) =>
      builder.overrideProvider(DestinationPreflightService).useFactory({
        factory: () => {
          const reader = new HorizonSorobanLedgerReader(horizonUrl, "http://127.0.0.1:1", "Test SDF Network ; September 2015");
          // The SAC lookup is a Soroban simulation — stub just that.
          reader.sacUnderlyingAsset = async () => ({ code: "USDC", issuer: USDC_ISSUER });
          const values: Record<string, unknown> = {
            destinationPreflight: { enabled: true, failOpen: false, cacheTtlMs: 60_000 },
            "stellar.network": "testnet",
            "stellar.horizonUrl": horizonUrl,
            "stellar.sorobanRpcUrl": "http://127.0.0.1:1",
          };
          return new DestinationPreflightService(
            { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>,
            reader,
          );
        },
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => horizon.close(() => resolve()));
  });

  const body = (user: string, minDstAmount = "990000") => ({
    user,
    srcChain: "ethereum",
    srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    srcTokenSymbol: "USDC",
    srcTokenDecimals: 6,
    srcAmount: "1000000",
    dstTokenContract: USDC_SAC,
    dstTokenSymbol: "USDC",
    dstTokenDecimals: 7,
    minDstAmount,
  });

  it("422 DST_ACCOUNT_NOT_FOUND for an unfunded destination", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/intents").send(body(Keypair.random().publicKey())).expect(422);
    expect(res.body).toMatchObject({ code: "DST_ACCOUNT_NOT_FOUND", error: "DST_ACCOUNT_NOT_FOUND" });
  });

  it("422 DST_TRUSTLINE_MISSING when the account has no USDC trustline", async () => {
    const user = Keypair.random().publicKey();
    horizonAccount(user);
    const res = await request(app.getHttpServer()).post("/api/v1/intents").send(body(user)).expect(422);
    expect(res.body.code).toBe("DST_TRUSTLINE_MISSING");
  });

  it("422 DST_NOT_AUTHORIZED when the issuer has frozen the trustline", async () => {
    const user = Keypair.random().publicKey();
    horizonAccount(user, { limit: "1000.0000000", authorized: false });
    const res = await request(app.getHttpServer()).post("/api/v1/intents").send(body(user)).expect(422);
    expect(res.body.code).toBe("DST_NOT_AUTHORIZED");
  });

  it("422 DST_TRUSTLINE_LIMIT when the remaining limit is below minDstAmount", async () => {
    const user = Keypair.random().publicKey();
    horizonAccount(user, { limit: "0.0500000" }); // 500_000 stroops of headroom
    const res = await request(app.getHttpServer()).post("/api/v1/intents").send(body(user, "990000")).expect(422);
    expect(res.body).toMatchObject({ code: "DST_TRUSTLINE_LIMIT", remainingLimit: "500000" });
  });

  it("creates the intent, then rejects the accept once the trustline is removed", async () => {
    const user = Keypair.random().publicKey();
    horizonAccount(user, { limit: "1000.0000000" });
    const created = await request(app.getHttpServer()).post("/api/v1/intents").send(body(user)).expect(201);
    const intentId = created.body.intentId as string;

    horizonAccount(user); // trustline removed after creation

    const solver = SEED_SOLVER_KEYPAIRS.ALPHA;
    const res = await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({
        solver: solver.publicKey(),
        signature: solver.sign(Buffer.from(buildAcceptMessage(intentId, solver.publicKey()))).toString("base64"),
      })
      .expect(422);
    expect(res.body.code).toBe("DST_TRUSTLINE_MISSING");

    const after = await request(app.getHttpServer()).get(`/api/v1/intents/${intentId}`).expect(200);
    expect(after.body.state).toBe("open");
    const audit = await request(app.getHttpServer()).get(`/api/v1/intents/${intentId}/audit`).expect(200);
    expect(audit.body.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "destination preflight failed" })]),
    );
  });
});
