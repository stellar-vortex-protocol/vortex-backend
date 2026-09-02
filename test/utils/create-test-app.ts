import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { WsAdapter } from "@nestjs/platform-ws";
import { json } from "express";
import { AppModule } from "../../src/app.module";
import { AppConfig } from "../../src/config/configuration";
import { HttpExceptionFilter } from "../../src/common/http-exception.filter";
import { PrismaService } from "../../src/prisma/prisma.service";

/**
 * Minimal PrismaService stand-in for e2e tests.
 *
 * IntentsService now calls this.prisma.intentAuditLog.create() as a
 * fire-and-forget DB write (issue #217).  We stub that here so the suite
 * does not require a live PostgreSQL instance.
 */
class MockPrismaService {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async onModuleInit(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async onModuleDestroy(): Promise<void> {}

  intentAuditLog = {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  };
}

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useClass(MockPrismaService)
    .compile();

  const app = moduleRef.createNestApplication();

  // Mirror the production body-size limit so 413 tests behave correctly
  app.use(json({ limit: "10kb" }));

  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Wire CORS the same way main.ts does so the e2e environment is faithful.
  const configService = app.get(ConfigService<AppConfig, true>);
  const corsOrigin = configService.get("corsOrigin", { infer: true });
  app.enableCors({ origin: corsOrigin });

  await app.init();
  return app;
}
