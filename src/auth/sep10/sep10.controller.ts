import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { AuthChallengeQueryDto } from "./dto/auth-challenge.query.dto";
import { AuthTokenDto } from "./dto/auth-token.dto";
import { Sep10Service } from "./sep10.service";

/**
 * SEP-10-style challenge authentication (issue #442).
 *
 * `GET /api/v1/auth/challenge?account=G...` issues the server-signed
 * challenge; `POST /api/v1/auth/token` exchanges the client-signed challenge
 * for a 15-minute EdDSA session JWT used as a Bearer token on REST and as
 * the handshake/first-message token on the WebSocket gateway.
 */
@ApiTags("auth")
@Controller("api/v1/auth")
export class Sep10Controller {
  constructor(private readonly sep10: Sep10Service) {}

  /**
   * Issues a SEP-10 challenge transaction bound to this server (home domain,
   * `web_auth_domain` operation, single-use nonce, 5-minute time bounds).
   */
  @Get("challenge")
  @ApiOperation({
    summary: "Issue a SEP-10 challenge transaction",
    description:
      "Returns a base64 challenge transaction for the given Stellar account. " +
      "Sign it with the account's key(s) and POST it to /api/v1/auth/token.",
  })
  @ApiOkResponse({ description: "Challenge transaction issued" })
  @ApiBadRequestResponse({ description: "account is not a valid Stellar G-address" })
  challenge(@Query() query: AuthChallengeQueryDto) {
    return this.sep10.buildChallenge(query.account);
  }

  /**
   * Exchanges a signed challenge for the short-lived session JWT. A challenge
   * can be exchanged exactly once; refreshing means re-running the flow.
   */
  @Post("token")
  @HttpCode(200)
  @ApiOperation({
    summary: "Exchange a signed SEP-10 challenge for a session JWT",
    description:
      "Verifies the server signature, time bounds, home domain, client signature " +
      "weight against the account threshold, and the single-use nonce, then " +
      "returns a 15-minute EdDSA JWT with `sub` and `role` claims.",
  })
  @ApiOkResponse({ description: "Session JWT issued" })
  @ApiBadRequestResponse({ description: "challenge failed verification or was already used" })
  token(@Body() dto: AuthTokenDto) {
    return this.sep10.exchange(dto.transaction);
  }

  /**
   * Revokes the presented session JWT (issue #704). The token's `jti` is
   * added to the shared denylist for its remaining lifetime, so every replica
   * rejects it on the next verification.
   */
  @Post("revoke")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Revoke the presented session JWT",
    description:
      "Adds the JWT's `jti` to the shared denylist with a TTL equal to its " +
      "remaining lifetime (never longer than SEP10_JWT_TTL_SECONDS). The token " +
      "must be supplied as `Authorization: Bearer <jwt>` and is rejected on all " +
      "replicas immediately after revocation.",
  })
  @ApiOkResponse({ description: "Session JWT revoked", schema: { example: { revoked: true } } })
  @ApiUnauthorizedResponse({ description: "missing, invalid, expired or already-revoked token" })
  async revoke(@Headers("authorization") authorization?: string): Promise<{ revoked: true }> {
    const token = extractBearerToken(authorization);
    if (!token) {
      throw new UnauthorizedException("missing bearer token");
    }
    await this.sep10.revoke(token);
    return { revoked: true };
  }
}

/** Extracts the raw JWT from an `Authorization: Bearer <jwt>` header. */
function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}
