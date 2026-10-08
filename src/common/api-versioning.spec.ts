import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Request, Response } from "express";
import request from "supertest";
import {
  createApiDeprecationHeadersMiddleware,
  enableApiVersioning,
  getApiVersionFromUrl,
  openApiDocumentForVersion,
} from "./api-versioning";

@Controller({ path: "resource", version: "1" })
class VersionedTestController {
  @Get()
  get() {
    return { ok: true };
  }
}

@Module({ controllers: [VersionedTestController] })
class VersionedTestModule {}

/**
 * Budget for tests that stand up a real Nest application and/or generate a
 * Swagger document.
 *
 * These are not unit tests: they pay a full `NestFactory.create` + `app.init`
 * plus `SwaggerModule.createDocument` walk over the module graph. That is
 * comfortably more than Jest's 5s default once the suite runs in parallel with
 * its siblings on a loaded machine, and a bootstrap that overran the default
 * failed as "Exceeded timeout of 5000 ms" — a statement about machine load, not
 * about the behaviour under test. Only bootstrap-heavy cases opt in.
 */
const BOOTSTRAP_TIMEOUT_MS = 60_000;

describe("API versioning helpers", () => {
  it("extracts a URI version without treating unversioned paths as v1", () => {
    expect(getApiVersionFromUrl("/api/v1/intents?limit=10")).toBe("1");
    expect(getApiVersionFromUrl("/api/v2/intents")).toBe("2");
    expect(getApiVersionFromUrl("/metrics")).toBe("unversioned");
  });

  it("filters OpenAPI paths to the requested URI version", () => {
    const document = {
      openapi: "3.0.0",
      info: { title: "Vortex", version: "0.1.0" },
      paths: {
        "/api/v1/intents": {},
        "/api/v2/intents": {},
        "/health": {},
      },
    } as never;

    const v1Document = openApiDocumentForVersion(document, "1");
    const v2Document = openApiDocumentForVersion(document, "2");

    expect(Object.keys(v1Document.paths)).toEqual(["/api/v1/intents"]);
    expect(v1Document.info.version).toBe("1");
    expect(Object.keys(v2Document.paths)).toEqual(["/api/v2/intents"]);
  });

  it("adds configured Deprecation, Sunset, and deprecation Link headers", () => {
    const setHeader = jest.fn();
    const next = jest.fn();
    const middleware = createApiDeprecationHeadersMiddleware({
      "1": {
        deprecatedAt: "2026-01-01T00:00:00Z",
        sunsetAt: "2027-01-01T00:00:00Z",
        deprecationLink: "https://example.test/deprecations/v1",
      },
    });

    middleware(
      { path: "/api/v1/intents" } as Request,
      { setHeader } as unknown as Response,
      next,
    );

    expect(setHeader).toHaveBeenNthCalledWith(1, "Deprecation", "@1767225600");
    expect(setHeader).toHaveBeenNthCalledWith(2, "Sunset", "Fri, 01 Jan 2027 00:00:00 GMT");
    expect(setHeader).toHaveBeenNthCalledWith(
      3,
      "Link",
      '<https://example.test/deprecations/v1>; rel="deprecation"',
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves unversioned routes and invalid lifecycle dates untouched", () => {
    const setHeader = jest.fn();
    const next = jest.fn();
    const middleware = createApiDeprecationHeadersMiddleware({
      "1": { deprecatedAt: "not-a-date", sunsetAt: "also-not-a-date" },
    });

    middleware(
      { path: "/metrics" } as Request,
      { setHeader } as unknown as Response,
      next,
    );

    expect(setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("routes controller metadata under api/vN and generates matching OpenAPI paths", async () => {
    const app: INestApplication = await NestFactory.create(VersionedTestModule, { logger: false });
    enableApiVersioning(app);
    app.use(
      createApiDeprecationHeadersMiddleware({
        "1": { deprecatedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    await app.init();

    try {
      const response = await request(app.getHttpServer()).get("/api/v1/resource").expect(200);
      expect(response.body).toEqual({ ok: true });
      expect(response.headers.deprecation).toBe("@1767225600");
      await request(app.getHttpServer()).get("/api/v2/resource").expect(404);

      const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const v1Document = openApiDocumentForVersion(document, "1");
      expect(v1Document.paths["/api/v1/resource"]).toBeDefined();
      expect(v1Document.paths["/api/v2/resource"]).toBeUndefined();
    } finally {
      await app.close();
    }
  }, BOOTSTRAP_TIMEOUT_MS);
});