import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AdminGuard } from "../admin/admin.guard";
import { AdminTokensController } from "./admin-tokens.controller";
import { AdminTokensService } from "./admin-tokens.service";

const SECRET = "ops:admin:this-is-a-long-secret";

describe("AdminTokensController RBAC", () => {
  let app: INestApplication;
  const tokens = {
    create: jest.fn().mockResolvedValue({ address: "0x1", status: "active" }),
    update: jest.fn().mockResolvedValue({ address: "0x1", status: "paused" }),
    delist: jest.fn().mockResolvedValue({ address: "0x1", status: "delisted" }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminTokensController],
      providers: [
        AdminGuard,
        Reflector,
        { provide: AdminTokensService, useValue: tokens },
        { provide: ConfigService, useValue: { get: () => SECRET } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const body = { chain: "ethereum", address: "0x1111111111111111111111111111111111111111" };

  it("rejects a missing admin key", async () => {
    await request(app.getHttpServer()).post("/api/v1/admin/tokens").send(body).expect(401);
    expect(tokens.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown admin key", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/admin/tokens")
      .set("x-admin-key", "not-the-secret")
      .send(body)
      .expect(401);
  });

  it("allows an admin key to create, update and delist", async () => {
    await request(app.getHttpServer()).post("/api/v1/admin/tokens").set("x-admin-key", "this-is-a-long-secret").send(body).expect(201);
    await request(app.getHttpServer())
      .patch("/api/v1/admin/tokens")
      .set("x-admin-key", "this-is-a-long-secret")
      .send({ ...body, status: "paused" })
      .expect(200);
    await request(app.getHttpServer())
      .delete("/api/v1/admin/tokens")
      .set("x-admin-key", "this-is-a-long-secret")
      .send(body)
      .expect(200);
    expect(tokens.create).toHaveBeenCalled();
    expect(tokens.update).toHaveBeenCalled();
    expect(tokens.delist).toHaveBeenCalled();
  });
});
