import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { ValidationPipe } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { json } from "express";
import { AppModule } from "./app.module";
import { AppConfig } from "./config/configuration";
import { LoggingInterceptor } from "./common/logging.interceptor";
import { HttpExceptionFilter } from "./common/http-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Issue #46 — explicit, tight body-size cap (DTOs are tiny)
  app.use(json({ limit: "10kb" }));

  // Issue #43 — baseline HTTP security headers via helmet.
  // Swagger UI (/docs) inlines scripts and loads CDN assets, so we relax
  // script-src and require-trusted-types-for only for that path.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Swagger UI bundles need inline scripts and CDN resources
          scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
          styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
          imgSrc: ["'self'", "data:", "cdn.jsdelivr.net"],
          connectSrc: ["'self'"],
        },
      },
      // Swagger UI uses inline event handlers; this policy would block it
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
  SwaggerModule.setup("docs", app, swaggerDocument);

  const configService = app.get(ConfigService<AppConfig, true>);
  const port = configService.get("port", { infer: true });
  const corsOrigin = configService.get("corsOrigin", { infer: true });

  app.enableCors({ origin: corsOrigin });

  await app.listen(port);
  console.log(`\nVortex backend (Nest) running on :${port}`);
  console.log(`WS    → ws://localhost:${port}/ws`);
  console.log(`Docs  → http://localhost:${port}/docs`);
}

bootstrap();
