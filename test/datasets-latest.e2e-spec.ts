import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { enableApiVersioning } from "../src/common/api-versioning";
import { HttpExceptionFilter } from "../src/common/http-exception.filter";
import { DatasetsController } from "../src/datasets/datasets.controller";
import { DatasetsService } from "../src/datasets/datasets.service";
import { DATASETS_CONFIG, DATASETS_STORAGE } from "../src/datasets/datasets.tokens";
import { DatasetsConfig } from "../src/datasets/datasets.types";
import { InMemoryObjectStorage } from "../src/datasets/object-storage";
import { IntentsService } from "../src/intents/intents.service";
import { SolversService } from "../src/solvers/solvers.service";

/** GET /api/v1/datasets/latest (#598) over a real DatasetsService + in-memory bucket. */
describe("GET /api/v1/datasets/latest (e2e)", () => {
  let app: INestApplication;
  let service: DatasetsService;

  beforeAll(async () => {
    const config: DatasetsConfig = {
      enabled: true,
      anonymize: false,
      salt: "",
      saltRotationHours: 24,
      saltRetentionWindows: 2,
      publicBucket: "vortex-public-datasets",
      storageKind: "memory",
      localDir: ".datasets",
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [DatasetsController],
      providers: [
        DatasetsService,
        { provide: DATASETS_CONFIG, useValue: config },
        { provide: DATASETS_STORAGE, useValue: new InMemoryObjectStorage() },
        { provide: IntentsService, useValue: { getAll: async () => [] } },
        { provide: SolversService, useValue: { getAll: async () => [] } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    enableApiVersioning(app);
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    service = app.get(DatasetsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 404 (not an empty 200) before anything is published", async () => {
    await request(app.getHttpServer()).get("/api/v1/datasets/latest").expect(404);
  });

  it("returns the newest date at its highest revision once published", async () => {
    await service.exportDaily(new Date("2026-09-28T12:00:00Z"));
    await service.exportDaily(new Date("2026-09-28T12:00:00Z"));
    await service.exportDaily(new Date("2026-09-27T12:00:00Z"));

    const res = await request(app.getHttpServer()).get("/api/v1/datasets/latest").expect(200);
    expect(res.body).toMatchObject({ date: "2026-09-28", revision: 2 });

    const list = await request(app.getHttpServer()).get("/api/v1/datasets").expect(200);
    expect(res.body).toEqual(list.body[0]);
  });
});
