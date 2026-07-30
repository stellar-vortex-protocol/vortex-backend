import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

describe("OpenAPI contract (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves the OpenAPI JSON at /docs-json", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    expect(res.body).toBeDefined();
    expect(res.body.openapi).toBeDefined();
    expect(res.body.info.title).toBe("Vortex Backend");
  });

  it("declares all intent endpoints", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const paths: Record<string, unknown> = res.body.paths;
    expect(paths["/api/v1/intents"]).toBeDefined();
    expect(paths["/api/v1/intents/open"]).toBeDefined();
    expect(paths["/api/v1/intents/user/{address}"]).toBeDefined();
    expect(paths["/api/v1/intents/{id}"]).toBeDefined();
    expect(paths["/api/v1/intents/{id}/accept"]).toBeDefined();
    expect(paths["/api/v1/intents/{id}/fill"]).toBeDefined();
    expect(paths["/api/v1/intents/{id}/cancel"]).toBeDefined();
    expect(paths["/api/v1/intents/quote"]).toBeDefined();
  });

  it("includes required body parameters for create intent", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const schema = res.body.paths["/api/v1/intents"].post;
    expect(schema).toBeDefined();
    expect(schema.requestBody).toBeDefined();
    const props = schema.requestBody.content["application/json"].schema.properties;
    expect(props.user).toBeDefined();
    expect(props.srcChain).toBeDefined();
    expect(props.srcAmount).toBeDefined();
    expect(props.dstTokenContract).toBeDefined();
  });

  it("includes accept-intent body with solver field", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const schema = res.body.paths["/api/v1/intents/{id}/accept"].post;
    expect(schema).toBeDefined();
    const props = schema.requestBody.content["application/json"].schema.properties;
    expect(props.solver).toBeDefined();
  });

  it("includes cancel-intent body with user field", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const schema = res.body.paths["/api/v1/intents/{id}/cancel"].post;
    expect(schema).toBeDefined();
    const props = schema.requestBody.content["application/json"].schema.properties;
    expect(props.user).toBeDefined();
  });

  it("includes fill-intent body with solver, fillAmount, and txHash fields", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const schema = res.body.paths["/api/v1/intents/{id}/fill"].post;
    expect(schema).toBeDefined();
    const props = schema.requestBody.content["application/json"].schema.properties;
    expect(props.solver).toBeDefined();
    expect(props.fillAmount).toBeDefined();
    expect(props.txHash).toBeDefined();
  });

  it("includes health endpoint", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const paths: Record<string, unknown> = res.body.paths;
    expect(paths["/api/v1/health"]).toBeDefined();
  });

  it("includes tokens endpoints", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const paths: Record<string, unknown> = res.body.paths;
    expect(paths["/api/v1/tokens"]).toBeDefined();
  });

  it("includes solvers endpoints", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const paths: Record<string, unknown> = res.body.paths;
    expect(paths["/api/v1/solvers"]).toBeDefined();
  });
});
