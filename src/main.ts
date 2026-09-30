import "./tracing";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { ConfigService } from "@nestjs/config";
import { ValidationPipe, Logger } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { json, Request, Response, NextFunction } from "express";
import { AppModule } from "./app.module";
import { AppConfig } from "./config/configuration";
import { LoggingInterceptor } from "./common/logging.interceptor";
import { HttpExceptionFilter } from "./common/http-exception.filter";
import { initSentry } from "./common/sentry";
import { IntentsSweeperService } from "./intents/intents-sweeper.service";
import { BODY_SIZE_LIMIT, JSON_MAX_DEPTH } from "./config/limits.config";
import { JobsService } from "./jobs/jobs.service";
import { adminAuthMiddleware } from "./admin/admin.guard";

// Initialise Sentry before the NestJS app boots so that any startup errors
// are also captured.  No-op when SENTRY_DSN is not set.
initSentry();

const startupLogger = new Logger("Bootstrap");

/**
 * Checks that SETTLEMENT_CONTRACT_ID and SOLVER_REGISTRY_CONTRACT_ID are set
 * when running outside the "development" environment.
 *
 * In development both default to "" (empty string) so that the service can boot
 * before contracts are deployed. In any other environment an empty value means the
 * deploy was misconfigured and we want to surface that immediately.
 *
 * @param configService - The NestJS ConfigService instance.
 * @param strict        - When true the process exits with code 1 instead of just warning.
 */
function checkContractIdEnvVars(
  configService: ConfigService<AppConfig, true>,
  strict = false,
): void {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "development") return;

  const settlementId = process.env.SETTLEMENT_CONTRACT_ID ?? "";
  const registryId = process.env.SOLVER_REGISTRY_CONTRACT_ID ?? "";

  const missing: string[] = [];
  if (!settlementId) missing.push("SETTLEMENT_CONTRACT_ID");
  if (!registryId) missing.push("SOLVER_REGISTRY_CONTRACT_ID");

  if (missing.length === 0) return;

  const message =
    `[startup-check] NODE_ENV is "${nodeEnv}" but the following contract-id ` +
    `env vars are empty: ${missing.join(", ")}. ` +
    `The service will be misconfigured — set these values in your environment.`;

  if (strict) {
    startupLogger.error(message);
    process.exit(1);
  } else {
    startupLogger.warn(message);
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Issue #20 — trust the first proxy hop so Helmet/HSTS sees the real
  // forwarded protocol when TLS terminates upstream behind nginx/ALB.
  //
  // `set` lives on the underlying Express instance; INestApplication's public
  // type does not declare it, so narrow to the Express app before calling.
  (app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void }).set(
    "trust proxy",
    1,
  );

  // Issue #46 — explicit, tight body-size cap (DTOs are tiny)
  app.use(json({ limit: BODY_SIZE_LIMIT }));

  // Issue #476 — reject JSON bodies whose nesting depth exceeds JSON_MAX_DEPTH.
  // Deep nesting can exhaust the call stack in both the JSON parser and the
  // recursive class-validator traversal before any field decorator fires.
  // All real DTOs are flat (depth ≤ 2); this cap of 10 gives 5× headroom.
  //
  // This middleware runs after express.json() has already parsed the body,
  // so we can inspect the already-materialised JS object without re-serialising.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.is("application/json")) return next();

    const effectiveDepth = parseInt(process.env.JSON_MAX_DEPTH ?? String(JSON_MAX_DEPTH), 10);

    /**
     * Measure the maximum nesting depth of an already-parsed JS value without
     * re-serialising it.  Pure recursive descent — depth O(n) on the number of
     * nodes, stack depth O(d) on the nesting depth.
     */
    function maxDepth(value: unknown, depth = 0): number {
      if (depth > effectiveDepth) return depth; // short-circuit once exceeded
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

  // Issue #43 / #302 — verify the security headers we rely on in production.
  // HSTS is explicitly configured so it is not silently skipped when a TLS
  // terminator sits in front of Express and `req.secure` is false unless the
  // proxy chain is trusted.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isDocsRoute =
      req.path === "/docs" ||
      req.path === "/docs-json" ||
      req.path.startsWith("/docs/");

    if (isDocsRoute) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }

    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", "data:", "cdn.jsdelivr.net"],
          objectSrc: ["'none'"],
          // Swagger UI bundles need inline scripts and CDN resources.
          scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
          styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      frameguard: { action: "deny" },
      noSniff: true,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      // Swagger UI uses inline event handlers; this policy would block it.
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Vortex Backend")
    .setDescription("Intent relay API + WebSocket feed for Vortex Protocol")
    .setVersion("0.1.0")
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);

  const shouldServeSwagger = process.env.NODE_ENV !== "production";
  if (shouldServeSwagger) {
    SwaggerModule.setup("docs", app, swaggerDocument);
  }

  const configService = app.get(ConfigService<AppConfig, true>);

  checkContractIdEnvVars(configService);

  // Issue #494 — graceful shutdown lets job workers finish or return in-flight
  // jobs. Signals are listed explicitly: SIGUSR2 is the manual-sweep trigger
  // below and must not shut the app down.
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);

  // Issue #494 — Bull Board UI (BullMQ driver only), behind admin RBAC.
  const board = app.get(JobsService).createBoardRouter("/admin/queues");
  if (board) {
    app.use("/admin/queues", adminAuthMiddleware(configService.get("adminApiKeys", { infer: true })), board);
  }

  // Issue #269 — operator-only manual sweep trigger (break-glass).
  // Send SIGUSR2 to the process (`kill -USR2 <pid>`) to run exactly one sweep
  // cycle on demand. This replaces the old "attach a Node.js REPL" procedure:
  // it needs shell access to the host, is not exposed over HTTP, and every
  // invocation is logged loudly by IntentsSweeperService. See
  // docs/runbooks/on-call.md → "Manual sweep trigger (emergency)".
  const sweeper = app.get(IntentsSweeperService);
  process.on("SIGUSR2", () => {
    void sweeper.triggerManualSweep("SIGUSR2");
  });

  const port = configService.get("port", { infer: true });
  const corsOrigin = configService.get("corsOrigin", { infer: true });

  app.enableCors({ origin: process.env.NODE_ENV === "production" ? corsOrigin : true });

  await app.listen(port);
  console.log(`\nVortex backend (Nest) running on :${port}`);
  console.log(`WS    → ws://localhost:${port}/ws`);
  console.log(`Docs  → http://localhost:${port}/docs`);
}

bootstrap();
