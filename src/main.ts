import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { AppConfig } from "./config/configuration";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService<AppConfig, true>);
  const port = configService.get("port", { infer: true });
  await app.listen(port);
  console.log(`\nVortex backend (Nest) running on :${port}`);
}

bootstrap();
