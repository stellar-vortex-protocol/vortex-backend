import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { verifyStellarSignature, buildDisputeReviewMessage, buildDisputeDecisionMessage } from "../common/stellar-signature";
import { REVIEWER_ADDRESSES } from "./disputes.tokens";

/**
 * RBAC for the reviewer workflow.
 *
 * A reviewer must be in the configured reviewer set (REVIEWER_ADDRESSES) and
 * prove control of that key by signing the canonical message for the action
 * (`x-reviewer-address` + `x-reviewer-signature` headers). Non-reviewers are
 * rejected with 403; malformed/missing credentials with 401.
 */
@Injectable()
export class ReviewerGuard implements CanActivate {
  constructor(@Inject(REVIEWER_ADDRESSES) private readonly reviewers: string[]) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const address = request.headers["x-reviewer-address"];
    const signature = request.headers["x-reviewer-signature"];

    if (!address || !signature) {
      throw new UnauthorizedException("Reviewer credentials required");
    }
    if (!this.reviewers.includes(address)) {
      throw new ForbiddenException("Address is not a registered reviewer");
    }

    const disputeId = request.params.disputeId as string;
    const body = (request.body ?? {}) as { resolution?: string; reason?: string };
    const message = body.resolution
      ? buildDisputeDecisionMessage(disputeId, body.resolution, body.reason ?? "")
      : buildDisputeReviewMessage(disputeId);

    verifyStellarSignature(address, message, signature);
    return true;
  }
}
