import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { SecretsService } from "./secrets.service";
import { SecretErrorEvent } from "./secrets.provider";

/**
 * Listens for secret load/refresh failures emitted by {@link SecretsService}
 * and logs/reports them without ever exposing secret values.
 */
@Injectable()
export class SecretsAlertingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecretsAlertingService.name);
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly secretsService: SecretsService) {}

  onModuleInit(): void {
    this.unsubscribe = this.secretsService.onSecretError((event: SecretErrorEvent) => {
      this.logger.error(
        `Secret refresh error for "${event.name}" (provider=${event.provider ?? this.secretsService.getProviderName()}): ${event.error.message}`,
      );
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
