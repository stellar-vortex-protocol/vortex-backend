import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "./app.module";
import { AppConfig } from "./config/configuration";
import { LoggingInterceptor } from "./common/logging.interceptor";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalInterceptors(new LoggingInterceptor());

  const configService = app.get(ConfigService<AppConfig, true>);
  const port = configService.get("port", { infer: true });
  await app.listen(port);
  console.log(`\nVortex backend (Nest) running on :${port}`);
  console.log(`WS    → ws://localhost:${port}/ws`);
}

bootstrap();
