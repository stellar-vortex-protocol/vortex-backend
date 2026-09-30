import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IntentsModule } from "../intents/intents.module";
import { SolversModule } from "../solvers/solvers.module";
import { AppConfig } from "../config/configuration";
import { DatasetsController } from "./datasets.controller";
import { DatasetsService } from "./datasets.service";
import { DATASETS_CONFIG, DATASETS_STORAGE } from "./datasets.tokens";
import { DatasetsConfig } from "./datasets.types";
import { InMemoryObjectStorage, LocalFilesystemStorage, ObjectStorage } from "./object-storage";

@Module({
  imports: [IntentsModule, SolversModule],
  controllers: [DatasetsController],
  providers: [
    {
      provide: DATASETS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): DatasetsConfig => {
        const datasets = config.get("datasets", { infer: true });
        return {
          enabled: datasets.enabled,
          anonymize: datasets.anonymize,
          salt: datasets.salt,
          saltRotationHours: datasets.saltRotationHours,
          saltRetentionWindows: datasets.saltRetentionWindows,
          publicBucket: datasets.publicBucket,
          storageKind: datasets.storageKind,
          localDir: datasets.localDir,
        };
      },
    },
    {
      provide: DATASETS_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): ObjectStorage => {
        const datasets = config.get("datasets", { infer: true });
        return datasets.storageKind === "memory"
          ? new InMemoryObjectStorage()
          : new LocalFilesystemStorage(datasets.localDir);
      },
    },
    DatasetsService,
  ],
  exports: [DatasetsService],
})
export class DatasetsModule {}
