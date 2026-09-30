import { Controller, Get, Header, NotFoundException } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Serves the WebSocket AsyncAPI document at `GET /docs/ws` (issue #456).
 *
 * The document is the repository's `docs/asyncapi.yaml`, read from disk at
 * first request and cached for the lifetime of the process. Two candidate
 * locations are probed so the route works from every layout the project runs
 * in:
 *
 *   - `<repo>/docs/asyncapi.yaml`        resolved from the working directory
 *   - `<repo>/docs/asyncapi.yaml`        resolved from this module, which
 *                                        lives two levels below the root both
 *                                        when running from `src/docs` (tests,
 *                                        `tsx`) and from `dist/docs` (built app)
 *
 * The production Docker image copies `docs/` alongside `dist/` for the same
 * reason. Deliberately reads raw text — parsing YAML would make `yaml` a
 * runtime dependency, and the parsed document is only needed by the type
 * generator and the contract test.
 *
 * Swagger UI is mounted at `/docs` *before* this controller's routes are
 * registered, so a request for `/docs/ws` reaches the Swagger router first and
 * falls through it untouched; `test/asyncapi-contract.e2e-spec.ts` proves the
 * route still answers.
 */
const SPEC_FILE = "docs/asyncapi.yaml";

let cachedSpec: string | null = null;

/** Locate `docs/asyncapi.yaml` for every supported runtime layout. */
export function resolveAsyncApiSpecPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), SPEC_FILE),
    path.resolve(__dirname, "..", "..", SPEC_FILE),
    path.resolve(__dirname, "..", "..", "..", SPEC_FILE),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Read (and cache) the AsyncAPI document as YAML. */
export function loadAsyncApiSpec(): string {
  if (cachedSpec !== null) return cachedSpec;

  const specPath = resolveAsyncApiSpecPath();
  if (!specPath) {
    throw new NotFoundException(
      `${SPEC_FILE} was not found — the WebSocket protocol document could not be served`,
    );
  }

  cachedSpec = fs.readFileSync(specPath, "utf8");
  return cachedSpec;
}

/** Exposed for tests: drop the in-process cache. */
export function clearAsyncApiSpecCache(): void {
  cachedSpec = null;
}

@Controller("docs")
export class AsyncApiController {
  /**
   * The AsyncAPI document for the `/ws` endpoint, as YAML.
   *
   * Consumers: AsyncAPI Studio, `asyncapi` CLI, code generators, and the SDK
   * type generator (`npm run generate:ws-types`).
   */
  @Get("ws")
  @Header("Content-Type", "text/yaml; charset=utf-8")
  getAsyncApiSpec(): string {
    return loadAsyncApiSpec();
  }
}
