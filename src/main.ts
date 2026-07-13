import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { ValidationPipe } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "./app.module";
import { AppConfig } from "./config/configuration";
import { LoggingInterceptor } from "./common/logging.interceptor";
import { HttpExceptionFilter } from "./common/http-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const configService = app.get(ConfigService<AppConfig, true>);
  const port = configService.get("port", { infer: true });
  await app.listen(port);
  console.log(`\nVortex backend (Nest) running on :${port}`);
  console.log(`WS    → ws://localhost:${port}/ws`);
}

bootstrap();
