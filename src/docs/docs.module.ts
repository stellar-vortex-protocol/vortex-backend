import { Module } from "@nestjs/common";
import { AsyncApiController } from "./asyncapi.controller";

/**
 * Serves the protocol documents that are not produced by Swagger:
 *
 *   - `GET /docs/ws` → `docs/asyncapi.yaml` (WebSocket protocol, issue #456)
 *
 * The REST/OpenAPI document keeps living in `main.ts` via `SwaggerModule`.
 */
@Module({
  controllers: [AsyncApiController],
})
export class DocsModule {}
