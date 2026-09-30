import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { WsAdapter } from "@nestjs/platform-ws";
import WebSocket from "ws";
import configuration, { AppConfig } from "../../src/config/configuration";
import { IntentsGateway } from "../../src/intents/intents.gateway";
import { IntentsService } from "../../src/intents/intents.service";
import { SolversService } from "../../src/solvers/solvers.service";
import { IntentCapabilityIndex } from "../../src/intents/solver-intent-matcher";
import { MetricsService } from "../../src/metrics/metrics.service";
import { Backplane, WS_BACKPLANE } from "../../src/intents/backplane/backplane.types";
import { MemoryBackplane } from "../../src/intents/backplane/memory.backplane";
import { IntentFeedService } from "../../src/intents/feed/intent-feed.service";

export interface WsTestApp {
  app: INestApplication;
  gateway: IntentsGateway;
  metrics: MetricsService;
  url: string;
}

/**
 * Boots only the WS gateway (with stubbed intents/solvers services) on a
 * random port, so gateway behaviour can be tested end to end over real
 * sockets without the rest of AppModule.
 */
export async function createWsTestApp(opts: {
  backplane?: Backplane;
  config?: Partial<AppConfig>;
  solvers?: Record<string, { address: string; isActive: boolean }>;
} = {}): Promise<WsTestApp> {
  const base = configuration();
  const values: AppConfig = { ...base, ...opts.config, ws: { ...base.ws, ...opts.config?.ws } };
  const config = {
    get: (key: keyof AppConfig) => values[key],
  } as unknown as ConfigService<AppConfig, true>;
  const solverRecords = opts.solvers ?? {};

  const moduleRef = await Test.createTestingModule({
    providers: [
      IntentsGateway,
      { provide: ConfigService, useValue: config },
      { provide: MetricsService, useValue: new MetricsService(config) },
      { provide: WS_BACKPLANE, useValue: opts.backplane ?? new MemoryBackplane() },
      { provide: IntentsService, useValue: { getByState: async () => [], get: async () => null } },
      {
        provide: SolversService,
        useValue: {
          get: async (address: string) =>
            solverRecords[address] && {
              supportedChains: ["stellar"],
              supportedTokens: ["USDC"],
              bondAmount: "1000",
              ...solverRecords[address],
            },
        },
      },
      { provide: IntentCapabilityIndex, useValue: { getEligibleFor: () => [], addIntent: () => undefined, removeIntent: () => undefined } },
      // The gateway delegates sequencing, replay and delivery to the
      // transport-agnostic feed service (issue #433), so the WS test harness has
      // to provide it too.
      IntentFeedService,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    gateway: app.get(IntentsGateway),
    metrics: app.get(MetricsService),
    url: `ws://127.0.0.1:${address.port}/ws`,
  };
}

/** Opens a client and collects every parsed frame it receives. */
export function connectClient(
  url: string,
  options?: WebSocket.ClientOptions,
): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
    ws.once("open", () => resolve({ ws, frames }));
    ws.once("error", reject);
  });
}

export async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
