import { Test } from "@nestjs/testing";
import { AppModule } from "./app.module";

/**
 * App-wide dependency-injection smoke test.
 *
 * The e2e suite is the only other thing that exercises the real module graph,
 * and it cannot run without a live Postgres. A DI regression — an unresolvable
 * provider, a bad `forwardRef`, a module that stopped being `@Global()` — is
 * otherwise invisible until deploy, and it takes the whole service down.
 *
 * `.compile()` resolves and instantiates the full provider graph without
 * calling lifecycle hooks, so this needs no database.
 */
describe("AppModule", () => {
  it("resolves its full provider graph", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  }, 60_000);
});
