import { BadRequestException, HttpException, ValidationPipe } from "@nestjs/common";
import * as fc from "fast-check";
import * as fs from "node:fs";
import * as path from "node:path";
import { adversarialJsonValue, assertWithSeedReport } from "./seed";

/** Mirrors the exact global pipe config from src/main.ts. */
const pipe = new ValidationPipe({ whitelist: true, transform: true });

/** Object-with-transform shape (ValidationPipe instance), not a bare function. */
type PipeLike = { transform: (value: unknown, metadata: unknown) => unknown };

interface DtoTarget { name: string; ctor: new () => unknown }

function collectDtoClasses(): DtoTarget[] {
  const roots = [
    path.resolve(__dirname, "../../src/intents/dto"),
    path.resolve(__dirname, "../../src/solvers/dto"),
  ];
  const out: DtoTarget[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of fs.readdirSync(root)) {
      if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
      let mod: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        mod = require(path.join(root, file)) as Record<string, unknown>;
      } catch (err) {
        process.stderr.write(`[fuzz] skipping unloadable module ${file}: ${(err as Error).message}\n`);
        continue;
      }
      for (const [key, value] of Object.entries(mod)) {
        if (typeof value === "function" && /Dto$|Request$|Response$|Query$|Params$/.test(key)) {
          out.push({ name: key, ctor: value as new () => unknown });
        }
      }
    }
  }
  return out;
}

const dtos = collectDtoClasses();
const pipeLike = pipe as unknown as PipeLike;

describe("DTO validation fuzz (issue #466)", () => {
  it("discovered at least one DTO to fuzz", () => {
    expect(dtos.length).toBeGreaterThan(0);
  });

  for (const { name, ctor } of dtos) {
    it(`${name}: validation never throws unhandled and rejects with 400 (not 500)`, async () => {
      await assertWithSeedReport(
        `dto:${name}`,
        fc.asyncProperty(adversarialJsonValue(), async (payload) => {
          let error: unknown = null;
          try {
            await pipeLike.transform(payload, { type: "body", metatype: ctor });
          } catch (e) {
            error = e;
          }
          if (error === null) return true;
          if (error instanceof HttpException) return error.getStatus() === 400;
          if (error instanceof BadRequestException) return true;
          return false;
        }),
      );
    });
  }

  it("prototype-pollution keys never escape into validated instances", async () => {
    await assertWithSeedReport(
      "proto-pollution",
      fc.asyncProperty(fc.constantFrom("__proto__", "constructor", "prototype"), async (key) => {
        const payload = JSON.parse(`{"${key}": {"polluted": true}, "amount": "1"}`) as Record<string, unknown>;
        let error: unknown = null;
        let result: unknown = null;
        try {
          result = await pipeLike.transform(payload, { type: "body", metatype: dtos[0]?.ctor ?? Object });
        } catch (e) {
          error = e;
        }
        if (error !== null) {
          return error instanceof HttpException ? error.getStatus() === 400 : false;
        }
        return ({} as Record<string, unknown>).polluted === undefined &&
          (result as Record<string, unknown> | null)?.polluted === undefined;
      }),
    );
  });
});