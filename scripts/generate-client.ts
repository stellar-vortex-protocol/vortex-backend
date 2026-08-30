/**
 * scripts/generate-client.ts
 *
 * Generates a fully-typed TypeScript client from the live OpenAPI document
 * that the vortex-backend Swagger/NestJS module produces at startup.
 *
 * Usage
 *   npm run generate:client          # builds first, then generates
 *
 * What it does
 *   1. Imports NestJS modules from the pre-compiled `dist/` directory so that
 *      TypeScript decorator metadata (`emitDecoratorMetadata`) is present and
 *      NestJS DI resolves constructor parameters correctly.
 *   2. Boots a throw-away NestJS application (no ports, no real DB) with a
 *      no-op PrismaService stub so that @nestjs/swagger can collect all
 *      controller/DTO decorator metadata.
 *   3. Writes the raw OpenAPI JSON to `src/generated/openapi.json` — useful
 *      for Postman, Redoc, or any other spec consumer.
 *   4. Feeds the document into `openapi-typescript` v7 (ESM-only, loaded via
 *      dynamic import) and writes the TypeScript types to
 *      `src/generated/api-types.ts`.
 *   5. Writes a re-export `src/generated/index.ts` as the SDK entry point.
 *
 * Downstream consumers (e.g. vortex-frontend)
 *   import type { paths, components } from "@vortex-protocol/backend-sdk";
 *
 *   // Example with openapi-fetch (https://openapi-ts.dev/openapi-fetch):
 *   import createClient from "openapi-fetch";
 *   const client = createClient<paths>({ baseUrl: "https://api.vortex.trade" });
 *   const { data } = await client.GET("/api/v1/intents", {
 *     params: { query: { state: "open" } },
 *   });
 *
 * Notes
 *   tsx (esbuild) intentionally strips TypeScript decorator metadata, so this
 *   script must load NestJS modules from the compiled `dist/` (tsc output) via
 *   require(), not from `src/` via tsx's transpiler.  openapi-typescript v7
 *   is ESM-only and is loaded via dynamic import(), which tsx handles at runtime
 *   regardless of the caller's module format.
 *
 * Closes #134
 */

import "reflect-metadata";
import * as fs from "node:fs";
import * as path from "node:path";

const DIST_DIR = path.resolve(__dirname, "../dist");

async function main(): Promise<void> {
  // ── 0. Guard: ensure dist/ exists ────────────────────────────────────────
  if (!fs.existsSync(DIST_DIR)) {
    console.error(
      "❌  dist/ not found.\n" +
        "    Run `npm run build` first, or just use `npm run generate:client`\n" +
        "    which builds automatically before generating.",
    );
    process.exit(1);
  }

  // ── 1. Stub env vars before any module that reads them is imported ────────
  process.env.NODE_ENV ??= "development";
  process.env.DATABASE_URL ??=
    "postgresql://vortex:vortex@localhost:5432/vortex?schema=public";

  // ── 2. Patch PrismaService prototype before AppModule loads ──────────────
  //
  // PrismaService.onModuleInit() calls $connect() which hangs indefinitely
  // when no Postgres is reachable.  We patch the prototype before requiring
  // AppModule so the no-op stubs are already in place when DI calls them.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaService } = require(
    path.join(DIST_DIR, "prisma", "prisma.service"),
  ) as typeof import("../src/prisma/prisma.service");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PrismaService.prototype as any).onModuleInit = async () => { /* no-op */ };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PrismaService.prototype as any).onModuleDestroy = async () => { /* no-op */ };

  // ── 3. Load openapi-typescript v7 via dynamic ESM import ─────────────────
  //
  // v7 is ESM-only (exports: { ".": { import: "./dist/index.mjs" } }).
  // dynamic import() works regardless of the caller's module format under tsx.
  const { default: openapiTS, astToString } = await import("openapi-typescript");

  // ── 4. Boot a throw-away NestJS app to capture the OpenAPI document ──────
  //
  // We require() from dist/ (compiled by tsc with emitDecoratorMetadata: true)
  // rather than importing from src/ (tsx/esbuild strips decorator metadata),
  // so that NestJS DI can resolve all constructor parameters.
  //
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NestFactory } = require("@nestjs/core") as typeof import("@nestjs/core");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WsAdapter } = require("@nestjs/platform-ws") as typeof import("@nestjs/platform-ws");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ValidationPipe } = require("@nestjs/common") as typeof import("@nestjs/common");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DocumentBuilder, SwaggerModule } = require("@nestjs/swagger") as typeof import("@nestjs/swagger");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AppModule } = require(path.join(DIST_DIR, "app.module")) as typeof import("../src/app.module");

  console.log("⚙️  Booting throw-away NestJS app to collect OpenAPI metadata…");

  const app = await NestFactory.create(AppModule, { logger: false });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Vortex Backend")
    .setDescription("Intent relay API + WebSocket feed for Vortex Protocol")
    .setVersion("0.1.0")
    .addTag("intents")
    .addTag("solvers")
    .addTag("tokens")
    .addTag("stats")
    .addTag("chain")
    .addServer("http://localhost:4000", "Local development")
    .addServer("https://api.vortex.trade", "Production")
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  // Shut down immediately — no ports bound, timers cleared by onModuleDestroy.
  await app.close();

  // ── 5. Write the raw OpenAPI JSON ─────────────────────────────────────────
  const outDir = path.resolve(__dirname, "../src/generated");
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, "openapi.json");
  fs.writeFileSync(jsonPath, JSON.stringify(document, null, 2) + "\n", "utf8");
  console.log(`✅  OpenAPI spec  → ${path.relative(process.cwd(), jsonPath)}`);

  // ── 6. Generate TypeScript types via openapi-typescript v7 ───────────────
  //
  // openapiTS(source) → Promise<ts.Node[]>; astToString(nodes) → string
  const ast = await openapiTS(document as Parameters<typeof openapiTS>[0]);
  const typesSource = astToString(ast);

  const typesPath = path.join(outDir, "api-types.ts");
  const fileHeader = [
    "/**",
    " * AUTO-GENERATED — do not edit by hand.",
    " * Regenerate with: npm run generate:client",
    " *",
    " * Usage (with openapi-fetch):",
    " *   import createClient from 'openapi-fetch';",
    " *   import type { paths } from './generated/api-types';",
    " *   const client = createClient<paths>({ baseUrl: 'http://localhost:4000' });",
    " *",
    " * Closes #134",
    " */",
    "",
    "// prettier-ignore",
    "",
  ].join("\n");

  fs.writeFileSync(typesPath, fileHeader + typesSource, "utf8");
  console.log(`✅  API types     → ${path.relative(process.cwd(), typesPath)}`);

  // ── 7. Write a re-export index.ts as the SDK entry point ─────────────────
  const indexPath = path.join(outDir, "index.ts");
  const indexContent = [
    "/**",
    " * AUTO-GENERATED — do not edit by hand.",
    " * Regenerate with: npm run generate:client",
    " *",
    " * SDK entry point for @vortex-protocol/backend-sdk.",
    " * Import types from here in downstream consumers:",
    " *",
    " *   import type { paths, components } from '@vortex-protocol/backend-sdk';",
    " */",
    "",
    "export type { paths, components, operations, webhooks } from './api-types';",
    "",
  ].join("\n");

  fs.writeFileSync(indexPath, indexContent, "utf8");
  console.log(`✅  SDK index     → ${path.relative(process.cwd(), indexPath)}`);

  console.log("\n🎉  Client SDK generation complete.");
  console.log(
    "   Commit src/generated/ and bump the package version to publish the SDK.\n",
  );
}

main().catch((err: unknown) => {
  console.error("❌  generate-client failed:", err);
  process.exit(1);
});
