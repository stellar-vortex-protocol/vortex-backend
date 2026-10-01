import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { WsAdapter } from "@nestjs/platform-ws";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json } from "express";
import { json, Request, Response, NextFunction } from "express";
import { AppModule } from "../../src/app.module";
import { AppConfig } from "../../src/config/configuration";
import { HttpExceptionFilter } from "../../src/common/http-exception.filter";
import { PrismaService } from "../../src/prisma/prisma.service";
import { BODY_SIZE_LIMIT, JSON_MAX_DEPTH } from "../../src/config/limits.config";
import { REPLAY_STORE, ReplayStore } from "../../src/intents/backplane/replay-store";

/**
 * Minimal PrismaService stand-in for e2e tests.
 *
 * IntentsService now calls this.prisma.intentAuditLog.create() as a
 * fire-and-forget DB write (issue #217).  We stub that here so the suite
 * does not require a live PostgreSQL instance.
 */
export class MockPrismaService {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async onModuleInit(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async onModuleDestroy(): Promise<void> {}

  intentAuditLog = {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  };
}

export interface CreateTestAppOptions {
  /**
   * Replay log to inject into the gateway (issue #457). Tests pass an
   * explicit store to simulate durability across an app restart or to set a
   * small retention window; when omitted the configured default applies.
   */
  replayStore?: ReplayStore;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<INestApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useClass(MockPrismaService);

  if (options.replayStore) {
    builder = builder.overrideProvider(REPLAY_STORE).useValue(options.replayStore);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();

  // Mirror the production body-size limit so 413 tests behave correctly
  app.use(json({ limit: BODY_SIZE_LIMIT }));

  // Mirror the JSON depth-check middleware from main.ts (issue #476)
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.is("application/json")) return next();

    const effectiveDepth = parseInt(process.env.JSON_MAX_DEPTH ?? String(JSON_MAX_DEPTH), 10);

    function maxDepth(value: unknown, depth = 0): number {
      if (depth > effectiveDepth) return depth;
      if (value === null || typeof value !== "object") return depth;
      const children = Object.values(value as Record<string, unknown>);
      if (children.length === 0) return depth;
      return Math.max(...children.map((v) => maxDepth(v, depth + 1)));
    }

    if (req.body !== undefined && maxDepth(req.body) > effectiveDepth) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: `JSON nesting depth exceeds the maximum allowed depth of ${effectiveDepth}`,
      });
      return;
    }

    next();
  });

  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      // Query strings arrive as text; convert them to the DTO's declared
      // types (e.g. ?limit=20 → number) so @IsInt/@Min/@Max behave the same
      // way they do for JSON bodies.
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Mirror main.ts so /docs-json serves the OpenAPI document.
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Vortex Backend")
    .setDescription("Intent relay API + WebSocket feed for Vortex Protocol")
    .setVersion("0.1.0")
    .build();
  SwaggerModule.setup(
    "docs",
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  // Wire CORS the same way main.ts does so the e2e environment is faithful.
  const configService = app.get(ConfigService<AppConfig, true>);
  const corsOrigin = configService.get("corsOrigin", { infer: true });
  app.enableCors({ origin: corsOrigin });

  await app.init();
  return app;
}

