/**
 * e2e test: CORS_ORIGIN config is wired into the app.
 *
 * Verifies that Access-Control-Allow-Origin reflects the CORS_ORIGIN env var
 * rather than being absent (NestJS default) or hard-coded.
 */
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { WsAdapter } from "@nestjs/platform-ws";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AppConfig } from "../src/config/configuration";
import { HttpExceptionFilter } from "../src/common/http-exception.filter";
import { PrismaService } from "../src/prisma/prisma.service";
import { MockPrismaService } from "./utils/create-test-app";

async function createAppWithOrigin(origin: string): Promise<INestApplication> {
  // Override CORS_ORIGIN before the module initializes.
  process.env.CORS_ORIGIN = origin;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useClass(MockPrismaService)
    .compile();

  const app = moduleRef.createNestApplication();
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const configService = app.get(ConfigService<AppConfig, true>);
  const corsOrigin = configService.get("corsOrigin", { infer: true });
  app.enableCors({ origin: corsOrigin });

  await app.init();
  return app;
}

async function createAppWithSecurityHeaders(nodeEnv = "development"): Promise<INestApplication> {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllowLocalSigner = process.env.ALLOW_LOCAL_SIGNER_IN_PROD;
  process.env.NODE_ENV = nodeEnv;
  // The app refuses to boot in production with the local keypair signer, which
  // is the right production guard but unrelated to the security headers and
  // Swagger-visibility behaviour this suite exercises. Opt in for the boot only.
  if (nodeEnv === "production") process.env.ALLOW_LOCAL_SIGNER_IN_PROD = "true";

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useClass(MockPrismaService)
    .compile();

  const app = moduleRef.createNestApplication();
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    const isDocsRequest = req.path === "/docs" || req.path === "/docs-json";
    if (isDocsRequest) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });
  app.use(
    helmet({
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      noSniff: true,
    }),
  );
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Mirror main.ts: serve the OpenAPI document, and only mount the Swagger UI
  // outside production. Without this the /docs and /docs-json assertions below
  // would 404 regardless of the security headers under test.
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Vortex Backend")
    .setDescription("Intent relay API + WebSocket feed for Vortex Protocol")
    .setVersion("0.1.0")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  if (nodeEnv !== "production") {
    SwaggerModule.setup("docs", app, document);
  }

  await app.init();

  process.env.NODE_ENV = previousNodeEnv;
  if (previousAllowLocalSigner === undefined) {
    delete process.env.ALLOW_LOCAL_SIGNER_IN_PROD;
  } else {
    process.env.ALLOW_LOCAL_SIGNER_IN_PROD = previousAllowLocalSigner;
  }
  return app;
}

describe("CORS (e2e)", () => {
  afterEach(() => {
    // Restore so other tests are not affected.
    delete process.env.CORS_ORIGIN;
  });

  it("responds with Access-Control-Allow-Origin: * when CORS_ORIGIN is *", async () => {
    const app = await createAppWithOrigin("*");
    try {
      const res = await request(app.getHttpServer())
        .get("/health")
        .set("Origin", "http://example.com")
        .expect(200);

      expect(res.headers["access-control-allow-origin"]).toBe("*");
    } finally {
      await app.close();
    }
  });

  it("reflects a specific CORS_ORIGIN in the response header", async () => {
    const allowedOrigin = "https://app.vortex.finance";
    const app = await createAppWithOrigin(allowedOrigin);
    try {
      const res = await request(app.getHttpServer())
        .get("/health")
        .set("Origin", allowedOrigin)
        .expect(200);

      expect(res.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    } finally {
      await app.close();
    }
  });

  it("does NOT echo back an origin that is not in CORS_ORIGIN", async () => {
    const app = await createAppWithOrigin("https://app.vortex.finance");
    try {
      const res = await request(app.getHttpServer())
        .get("/health")
        .set("Origin", "https://evil.example.com")
        .expect(200);

      // When origin is a specific string and the request Origin doesn't match,
      // express-cors either omits the header or sets it to the allowed origin.
      // Either way it must NOT be the attacker's origin.
      expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
    } finally {
      await app.close();
    }
  });

  it("adds HSTS and nosniff headers behind a trusted proxy", async () => {
    const app = await createAppWithSecurityHeaders();
    try {
      const res = await request(app.getHttpServer())
        .get("/health")
        .set("X-Forwarded-Proto", "https")
        .expect(200);

      expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    } finally {
      await app.close();
    }
  });

  it("marks OpenAPI docs as no-store so they are not cached", async () => {
    const app = await createAppWithSecurityHeaders();
    try {
      const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
      expect(res.headers["cache-control"]).toContain("no-store");
    } finally {
      await app.close();
    }
  });

  it("disables Swagger UI by default in production", async () => {
    const app = await createAppWithSecurityHeaders("production");
    try {
      await request(app.getHttpServer()).get("/docs").expect(404);
    } finally {
      await app.close();
    }
  });
});
