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
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AppConfig } from "../src/config/configuration";
import { HttpExceptionFilter } from "../src/common/http-exception.filter";

async function createAppWithOrigin(origin: string): Promise<INestApplication> {
  // Override CORS_ORIGIN before the module initializes.
  process.env.CORS_ORIGIN = origin;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

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
});
