/**
 * AbuseController — admin and self-service transparency endpoints for the
 * abuse detector.
 *
 * Operator token (`X-Admin-Key` = KILLSWITCH_OPERATOR_TOKEN):
 *   GET    /api/v1/abuse/audit/:address  → last N events for a user
 *   GET    /api/v1/abuse/score/:address  → latest cached score for a user
 *
 * Admin RBAC (`X-Admin-Key` from ADMIN_API_KEYS, via AdminGuard — issue #605):
 *   GET    /api/v1/abuse/allowlist       → list runtime allowlist entries
 *   POST   /api/v1/abuse/allowlist       → add an entry (live, no restart)
 *   DELETE /api/v1/abuse/allowlist/:id   → remove an entry (live, no restart)
 *
 * Self-service, signed by the address holder (issue #607):
 *   GET    /api/v1/abuse/me/score        → caller's own current score
 *   GET    /api/v1/abuse/me/audit        → caller's own reduced audit view
 *
 * None of these routes sit behind the abuse detector itself, so they stay
 * reachable even when Redis is degraded.
 *
 * Self-service authentication
 * ───────────────────────────
 * The caller proves control of the address by sending:
 *   X-Vortex-Address    — Stellar G-address
 *   X-Vortex-Signature  — base64 Ed25519 signature over the canonical message
 *   X-Vortex-Nonce      — unique string, consumed once (replay protection)
 *   X-Vortex-Expires-At — Unix seconds; at most 5 minutes in the future
 * Canonical message: see {@link buildAbuseSelfServiceMessage}.
 * The address queried is always the verified signer; there is no parameter
 * that could point the request at someone else's data.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { AbuseScoreService } from "./abuse-score.service";
import { AllowlistEntryView, AllowlistListing, AllowlistService } from "./allowlist.service";
import { AbuseAuditEvent, AbuseSelfAuditEvent, toSelfAuditEvent } from "./abuse.types";
import { CreateAllowlistEntryDto } from "./dto/allowlist-entry.dto";
import { buildAbuseSelfServiceMessage, verifyStellarSignature } from "../common/stellar-signature";
import { SignatureNonceService } from "../common/signature-nonce.service";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";

/** Clock skew tolerated on X-Vortex-Expires-At (seconds). */
const SELF_SERVICE_CLOCK_SKEW_SECONDS = 60;

/** Furthest in the future X-Vortex-Expires-At may be (seconds). */
const SELF_SERVICE_MAX_TTL_SECONDS = 300;

@ApiTags("abuse")
@Controller({ path: "abuse", version: "1" })
export class AbuseController {
  constructor(
    private readonly scorer: AbuseScoreService,
    private readonly allowlist: AllowlistService,
    private readonly nonces: SignatureNonceService,
  ) {}

  // ── Operator endpoints ─────────────────────────────────────────────────────

  /**
   * Returns the last `limit` (default 20, max 100) audit events for the
   * specified user address.
   */
  @Get("audit/:address")
  @ApiOperation({ summary: "Abuse audit history for a user address (admin)" })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiOkResponse({ description: "Array of AbuseAuditEvent" })
  async getAuditHistory(
    @Param("address") address: string,
    @Query("limit") limitRaw?: string,
    @Headers("x-admin-key") adminKey?: string,
  ): Promise<{ address: string; events: AbuseAuditEvent[] }> {
    this.requireAdminKey(adminKey);
    const events = await this.scorer.getAuditHistory(address, parseLimit(limitRaw));
    return { address, events };
  }

  /** Returns the latest cached abuse score for an address. */
  @Get("score/:address")
  @ApiOperation({ summary: "Latest cached abuse score for a user address (admin)" })
  @ApiOkResponse({ description: "Score object" })
  async getScore(
    @Param("address") address: string,
    @Headers("x-admin-key") adminKey?: string,
  ): Promise<{ address: string; score: number | null }> {
    this.requireAdminKey(adminKey);
    const score = await this.scorer.getCachedScore(address);
    return { address, score };
  }

  // ── Allowlist management (issue #605) ──────────────────────────────────────

  /** Runtime allowlist entries, plus counts of the read-only ABUSE_ALLOWLIST seed. */
  @Get("allowlist")
  @UseGuards(AdminGuard)
  @RequireAdminRole("admin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({ summary: "List abuse allowlist entries (admin)" })
  listAllowlist(): Promise<AllowlistListing> {
    return this.allowlist.list();
  }

  /** Add an entry. Takes effect on every replica without a restart. */
  @Post("allowlist")
  @UseGuards(AdminGuard)
  @RequireAdminRole("admin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({ summary: "Add an abuse allowlist entry (admin)" })
  addAllowlistEntry(
    @Body() dto: CreateAllowlistEntryDto,
    @CurrentAdmin() admin: AdminPrincipal,
  ): Promise<AllowlistEntryView> {
    return this.allowlist.add(dto, admin);
  }

  /** Remove an entry. Entries seeded from ABUSE_ALLOWLIST cannot be removed here. */
  @Delete("allowlist/:id")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @RequireAdminRole("admin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({ summary: "Remove an abuse allowlist entry (admin)" })
  removeAllowlistEntry(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AdminPrincipal,
  ): Promise<AllowlistEntryView> {
    return this.allowlist.remove(id, admin);
  }

  // ── Self-service (issue #607) ──────────────────────────────────────────────

  /** The caller's own current abuse score. */
  @Get("me/score")
  @ApiOperation({ summary: "Your own abuse score (signed by the address holder)" })
  @ApiHeader({ name: "x-vortex-address", required: true })
  @ApiHeader({ name: "x-vortex-signature", required: true })
  @ApiHeader({ name: "x-vortex-nonce", required: true })
  @ApiHeader({ name: "x-vortex-expires-at", required: true })
  async getSelfScore(
    @Headers("x-vortex-address") address?: string,
    @Headers("x-vortex-signature") signature?: string,
    @Headers("x-vortex-nonce") nonce?: string,
    @Headers("x-vortex-expires-at") expiresAt?: string,
  ): Promise<{ address: string; score: number | null }> {
    const self = await this.verifySelf({ address, signature, nonce, expiresAt });
    return { address: self, score: await this.scorer.getCachedScore(self) };
  }

  /**
   * The caller's own recent audit events, reduced to timestamps, operation,
   * action and signal names/weights. No IPs, detail strings or other actors.
   */
  @Get("me/audit")
  @ApiOperation({ summary: "Your own abuse audit history, reduced view (signed by the address holder)" })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiHeader({ name: "x-vortex-address", required: true })
  @ApiHeader({ name: "x-vortex-signature", required: true })
  @ApiHeader({ name: "x-vortex-nonce", required: true })
  @ApiHeader({ name: "x-vortex-expires-at", required: true })
  async getSelfAudit(
    @Query("limit") limitRaw?: string,
    @Headers("x-vortex-address") address?: string,
    @Headers("x-vortex-signature") signature?: string,
    @Headers("x-vortex-nonce") nonce?: string,
    @Headers("x-vortex-expires-at") expiresAt?: string,
  ): Promise<{ address: string; events: AbuseSelfAuditEvent[] }> {
    const self = await this.verifySelf({ address, signature, nonce, expiresAt });
    const events = await this.scorer.getAuditHistory(self, parseLimit(limitRaw));
    return { address: self, events: events.map(toSelfAuditEvent) };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private requireAdminKey(key?: string): void {
    const expected = process.env.KILLSWITCH_OPERATOR_TOKEN ?? "";
    if (!expected || key !== expected) {
      throw new ForbiddenException("Admin key required");
    }
  }

  /**
   * Verify the signed-message proof and return the caller's address in the
   * lowercased form the abuse detector keys its data by. Order matters:
   * the nonce is consumed only after the signature checks out, so a forged
   * request cannot burn a legitimate caller's nonce.
   */
  private async verifySelf(opts: {
    address?: string;
    signature?: string;
    nonce?: string;
    expiresAt?: string;
  }): Promise<string> {
    const { address, signature, nonce } = opts;
    if (!address || !signature || !nonce || !opts.expiresAt) {
      throw new UnauthorizedException(
        "X-Vortex-Address, X-Vortex-Signature, X-Vortex-Nonce and X-Vortex-Expires-At headers are required",
      );
    }
    if (nonce.length > 128) throw new UnauthorizedException("X-Vortex-Nonce is too long");

    const expiresAt = Number(opts.expiresAt);
    if (!Number.isInteger(expiresAt)) {
      throw new UnauthorizedException("X-Vortex-Expires-At must be a Unix timestamp in seconds");
    }
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt < now - SELF_SERVICE_CLOCK_SKEW_SECONDS) {
      throw new UnauthorizedException("Signature has expired");
    }
    if (expiresAt > now + SELF_SERVICE_MAX_TTL_SECONDS + SELF_SERVICE_CLOCK_SKEW_SECONDS) {
      throw new UnauthorizedException("X-Vortex-Expires-At is too far in the future");
    }

    verifyStellarSignature(address, buildAbuseSelfServiceMessage(address, nonce, expiresAt), signature);

    // Namespaced so a self-service nonce can never collide with an intent-signing nonce.
    const fresh = await this.nonces.consume(address, `abuse-self-service:${nonce}`, expiresAt);
    if (!fresh) throw new UnauthorizedException("Nonce has already been used");

    return address.toLowerCase();
  }
}

function parseLimit(raw?: string): number {
  return Math.min(parseInt(raw ?? "20", 10) || 20, 100);
}
