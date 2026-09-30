import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { ReviewerGuard } from "./reviewer.guard";
import { buildDisputeDecisionMessage, buildDisputeReviewMessage } from "../common/stellar-signature";

function makeContext(
  headers: Record<string, string>,
  params: Record<string, string>,
  body: Record<string, unknown> = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers, params, body }) }),
  } as unknown as ExecutionContext;
}

describe("ReviewerGuard (RBAC)", () => {
  const reviewer = Keypair.random();
  const other = Keypair.random();

  function sign(keypair: Keypair, message: string): string {
    return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
  }

  it("allows a registered reviewer with a valid decision signature", () => {
    const guard = new ReviewerGuard([reviewer.publicKey()]);
    const message = buildDisputeDecisionMessage("d1", "overturned", "evidence matches");
    const ctx = makeContext(
      {
        "x-reviewer-address": reviewer.publicKey(),
        "x-reviewer-signature": sign(reviewer, message),
      },
      { disputeId: "d1" },
      { resolution: "overturned", reason: "evidence matches" },
    );

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("allows a registered reviewer with a valid review signature", () => {
    const guard = new ReviewerGuard([reviewer.publicKey()]);
    const message = buildDisputeReviewMessage("d1");
    const ctx = makeContext(
      {
        "x-reviewer-address": reviewer.publicKey(),
        "x-reviewer-signature": sign(reviewer, message),
      },
      { disputeId: "d1" },
      {},
    );

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("rejects a non-reviewer address", () => {
    const guard = new ReviewerGuard([reviewer.publicKey()]);
    const ctx = makeContext(
      {
        "x-reviewer-address": other.publicKey(),
        "x-reviewer-signature": sign(other, buildDisputeReviewMessage("d1")),
      },
      { disputeId: "d1" },
    );

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("rejects missing credentials", () => {
    const guard = new ReviewerGuard([reviewer.publicKey()]);
    expect(() => guard.canActivate(makeContext({}, { disputeId: "d1" }))).toThrow(UnauthorizedException);
  });

  it("rejects an invalid signature", () => {
    const guard = new ReviewerGuard([reviewer.publicKey()]);
    const ctx = makeContext(
      {
        "x-reviewer-address": reviewer.publicKey(),
        "x-reviewer-signature": sign(reviewer, "some-other-message"),
      },
      { disputeId: "d1" },
      { resolution: "overturned", reason: "evidence matches" },
    );

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
