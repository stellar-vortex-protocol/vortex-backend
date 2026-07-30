import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "../../src/app.module";
import { HttpExceptionFilter } from "../../src/common/http-exception.filter";
import { PrismaService } from "../../src/prisma/prisma.service";

/**
 * Minimal PrismaService stand-in for e2e tests.
 *
 * The feature services (IntentsService, SolversService, etc.) still use
 * in-memory stores in the current codebase, so they never call PrismaService
 * directly.  We only need to prevent the real $connect() from being called so
 * the suite does not require a live PostgreSQL instance.
 */
class MockPrismaService {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async onModuleInit(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async onModuleDestroy(): Promise<void> {}
}

export async function createTestApp(): Promise<INestApplication> {
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
  await app.init();
  return app;
}
