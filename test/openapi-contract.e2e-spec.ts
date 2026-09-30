import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

describe("OpenAPI contract (e2e)", () => {
  let app: INestApplication;

  /**
   * Body schemas are emitted as `$ref`s into `components.schemas`; resolve the
   * reference (or use the inline schema) so callers can assert on `properties`.
   */
  function bodyProps(
    doc: {
      paths: Record<string, Record<string, any>>;
      components?: { schemas?: Record<string, any> };
    },
    path: string,
    method: string,
  ): Record<string, unknown> {
    const schema = doc.paths[path][method].requestBody.content["application/json"].schema;
    const resolved = schema.$ref
      ? doc.components?.schemas?.[String(schema.$ref).split("/").pop() as string]
      : schema;
    expect(resolved).toBeDefined();
    return resolved.properties;
  }

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
    expect(res.body.paths["/api/v1/intents"].post.requestBody).toBeDefined();
    const props = bodyProps(res.body, "/api/v1/intents", "post");
    expect(props.user).toBeDefined();
    expect(props.srcChain).toBeDefined();
    expect(props.srcAmount).toBeDefined();
    expect(props.dstTokenContract).toBeDefined();
  });

  it("includes accept-intent body with solver field", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    expect(res.body.paths["/api/v1/intents/{id}/accept"].post).toBeDefined();
    const props = bodyProps(res.body, "/api/v1/intents/{id}/accept", "post");
    expect(props.solver).toBeDefined();
  });

  it("includes cancel-intent body with user field", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    expect(res.body.paths["/api/v1/intents/{id}/cancel"].post).toBeDefined();
    const props = bodyProps(res.body, "/api/v1/intents/{id}/cancel", "post");
    expect(props.user).toBeDefined();
  });

  it("includes fill-intent body with solver, fillAmount, and txHash fields", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    expect(res.body.paths["/api/v1/intents/{id}/fill"].post).toBeDefined();
    const props = bodyProps(res.body, "/api/v1/intents/{id}/fill", "post");
    expect(props.solver).toBeDefined();
    expect(props.fillAmount).toBeDefined();
    expect(props.txHash).toBeDefined();
  });

  it("includes health endpoint", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const paths: Record<string, unknown> = res.body.paths;
    expect(paths["/health"]).toBeDefined();
    expect(paths["/health/live"]).toBeDefined();
    expect(paths["/health/ready"]).toBeDefined();
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

  // -------------------------------------------------------------------------
  // Issue #271 — SorobanController and TokensController must document their
  // response shapes just like every other controller.
  // -------------------------------------------------------------------------

  const okSchema = (op: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }) =>
    op.responses?.["200"]?.content?.["application/json"]?.schema;

  it("documents a 200 response schema for every chain (Soroban) route", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const paths = res.body.paths;
    for (const route of [
      "/api/v1/chain/health",
      "/api/v1/chain/ledger",
      "/api/v1/chain/network",
      "/api/v1/chain/account/{publicKey}",
    ]) {
      expect(paths[route]).toBeDefined();
      expect(okSchema(paths[route].get)).toBeDefined();
    }
  });

  it("documents the 400 and 429 responses on the account route", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const op = res.body.paths["/api/v1/chain/account/{publicKey}"].get;
    expect(op.responses["400"]).toBeDefined();
    expect(op.responses["429"]).toBeDefined();
  });

  it("documents a 200 response schema for every tokens route", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const paths = res.body.paths;
    for (const route of ["/api/v1/tokens", "/api/v1/tokens/stellar"]) {
      expect(paths[route]).toBeDefined();
      expect(okSchema(paths[route].get)).toBeDefined();
    }
  });
});
