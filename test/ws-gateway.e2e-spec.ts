import { INestApplication } from "@nestjs/common";
import request from "supertest";
import WebSocket from "ws";
import { createTestApp } from "./utils/create-test-app";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { buildAcceptMessage } from "../src/common/stellar-signature";

const ALPHA_KP = SEED_SOLVER_KEYPAIRS.ALPHA;

function sign(kp: typeof ALPHA_KP, msg: string): string {
  return kp.sign(Buffer.from(msg, "utf8")).toString("base64");
}

const validCreateBody = {
  user: "GE2ETESTUSER1234567",
  srcChain: "ethereum",
  srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  srcTokenSymbol: "USDC",
  srcTokenDecimals: 6,
  srcAmount: "1000000",
  dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  dstTokenSymbol: "USDC",
  dstTokenDecimals: 7,
  minDstAmount: "9900000",
};

describe("IntentsGateway WebSocket (e2e)", () => {
  let app: INestApplication;
  let httpServer: any;

  beforeAll(async () => {
    app = await createTestApp();
    // supertest never leaves the HTTP server listening; bind it so the WS
    // clients below have a port to dial.
    await app.listen(0);
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should receive connected and snapshot messages on connection", (done) => {
    const port = httpServer.address().port;
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const messages: any[] = [];

    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length === 2) {
        expect(messages[0].type).toBe("connected");
        expect(messages[0].message).toBe("Vortex intent stream");
        expect(messages[1].type).toBe("snapshot");
        expect(Array.isArray(messages[1].intents)).toBe(true);
        ws.close();
        done();
      }
    });

    ws.on("error", done);
  });

  it("should broadcast intent_created event to WebSocket clients", (done) => {
    const port = httpServer.address().port;
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const messages: any[] = [];

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);

      if (messages.length === 2) {
        // Skip connected and snapshot
        return;
      }

      if (messages.length === 3 && msg.type === "intent_created") {
        expect(msg.intent).toBeDefined();
        expect(msg.intent.state).toBe("open");
        ws.close();
        done();
      }
    });

    ws.on("error", done);

    ws.on("open", () => {
      setTimeout(() => {
        request(httpServer)
          .post("/api/v1/intents")
          .send(validCreateBody)
          .catch(done);
      }, 100);
    });
  });

  it("should broadcast intent_accepted event to WebSocket clients", (done) => {
    const port = httpServer.address().port;
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    let intentId = "";
    const messages: any[] = [];

    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);

      if (messages.length === 2) {
        // Skip connected and snapshot
        return;
      }

      if (messages.length === 3 && msg.type === "intent_created") {
        intentId = msg.intent.intentId;
        const acceptSig = sign(ALPHA_KP, buildAcceptMessage(intentId, ALPHA_KP.publicKey()));
        setTimeout(() => {
          request(httpServer)
            .post(`/api/v1/intents/${intentId}/accept`)
            .send({ solver: ALPHA_KP.publicKey(), signature: acceptSig })
            .catch(done);
        }, 100);
      }

      if (msg.type === "intent_accepted" && msg.intentId === intentId) {
        expect(msg.solver).toBe(ALPHA_KP.publicKey());
        ws.close();
        done();
      }
    });

    ws.on("error", done);

    ws.on("open", () => {
      setTimeout(() => {
        request(httpServer)
          .post("/api/v1/intents")
          .send(validCreateBody)
          .catch(done);
      }, 100);
    });
  });
});
