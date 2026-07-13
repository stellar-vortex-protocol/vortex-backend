import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { TokensModule } from "./tokens/tokens.module";

@Module({
  imports: [ConfigModule, HealthModule, TokensModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
