import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ReviewerRosterService } from "./reviewer-roster.service";

/**
 * Authorizes dispute-reviewer requests against the database-backed roster
 * (issue #612), falling back to `REVIEWER_ADDRESSES` when no roster rows exist.
 */
@Injectable()
export class ReviewerGuard implements CanActivate {
  constructor(private readonly roster: ReviewerRosterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const address: string | undefined = req.user?.stellarAddress ?? req.user?.address;
    if (!address) {
      throw new UnauthorizedException("reviewer address required");
    }
    const active = await this.roster.isActive(address);
    if (!active) {
      throw new UnauthorizedException("not an active dispute reviewer");
    }
    return true;
  }
}
