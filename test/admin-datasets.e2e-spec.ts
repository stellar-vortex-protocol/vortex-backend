import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";
import { DATASET_SCHEMAS, fieldNames } from "../src/datasets/schemas";
import { checksum } from "../src/datasets/manifest";

/** Issue #592: POST /api/v1/admin/datasets/export. */
describe("AdminDatasetsController (e2e)", () => {
  const ADMIN_SECRET = "e2e-datasets-admin-secret-0001";
  let app: INestApplication;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of [
      "ADMIN_API_KEYS",
      "DATASETS_STORAGE",
      "DATASETS_EXPORT_MAX_DAYS",
    ])
      saved[key] = process.env[key];
    process.env.ADMIN_API_KEYS = `ops:admin:${ADMIN_SECRET}`;
    process.env.DATASETS_STORAGE = "memory";
    process.env.DATASETS_EXPORT_MAX_DAYS = "31";
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const server = () => app.getHttpServer();
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    kind: "intents",
    from: "2020-01-01",
    to: today,
    format: "csv",
  };

  it("rejects calls without an admin key", async () => {
    await request(server())
      .post("/api/v1/admin/datasets/export")
      .send(body)
      .expect(401);
  });

  it("rejects a wrong admin key", async () => {
    await request(server())
      .post("/api/v1/admin/datasets/export")
      .set("x-admin-key", "not-the-right-secret-at-all")
      .send({ ...body, from: today })
      .expect(401);
  });

  it("returns a CSV matching the schema with manifest headers", async () => {
    const res = await request(server())
      .post("/api/v1/admin/datasets/export")
      .set("x-admin-key", ADMIN_SECRET)
      .send({ ...body, from: today })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const bytes = res.body as Buffer;
    const [header, ...rows] = bytes.toString("utf8").trim().split("\n");
    expect(header.split(",")).toEqual(fieldNames(DATASET_SCHEMAS.intents));

    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["content-disposition"]).toContain(
      `intents_${today}_${today}.csv`,
    );
    expect(res.headers["x-dataset-schema"]).toBe("intents-v1.0");
    expect(res.headers["x-dataset-from"]).toBe(today);
    expect(res.headers["x-dataset-to"]).toBe(today);
    expect(Number(res.headers["x-dataset-row-count"])).toBe(rows.length);
    expect(res.headers["x-dataset-sha256"]).toBe(checksum(bytes));
  });

  it("rejects a range wider than DATASETS_EXPORT_MAX_DAYS with 400", async () => {
    await request(server())
      .post("/api/v1/admin/datasets/export")
      .set("x-admin-key", ADMIN_SECRET)
      .send({ ...body, from: "2026-01-01", to: "2026-03-01" })
      .expect(400);
  });

  it("validates the request body", async () => {
    await request(server())
      .post("/api/v1/admin/datasets/export")
      .set("x-admin-key", ADMIN_SECRET)
      .send({
        kind: "users",
        from: "2026-01-01",
        to: "2026-01-02",
        format: "xlsx",
      })
      .expect(400);
  });
});
