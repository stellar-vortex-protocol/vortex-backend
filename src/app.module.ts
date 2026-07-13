import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { TokensModule } from "./tokens/tokens.module";
import { IntentsModule } from "./intents/intents.module";

@Module({
  imports: [ConfigModule, HealthModule, TokensModule, IntentsModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
