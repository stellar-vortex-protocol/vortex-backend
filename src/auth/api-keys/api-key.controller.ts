import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Optional,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { AdminGuard, RequireAdminRole } from "../../admin/admin.guard";
import { SolverCredentialService } from "../solver-credentials/solver-credential.service";
import { ApiKeyService } from "./api-key.service";
import { CreateApiKeyDto } from "./dto/create-api-key.dto";
import { RotateApiKeyDto } from "./dto/rotate-api-key.dto";

const DEFAULT_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_WINDOW_DAYS = 7;
const MAX_EXPIRY_WINDOW_DAYS = 365;

/**
 * Parses a `from`/`to` query value as either an ISO-8601 timestamp or an
 * epoch-seconds integer. Returns `undefined` when the value is absent.
 */
function parseTimestamp(value: string | undefined, field: string): Date | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) {
      throw new BadRequestException(`${field} must be a valid epoch-seconds value`);
    }
    return new Date(seconds * 1000);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(
      `${field} must be an ISO-8601 timestamp or epoch seconds`,
    );
  }
  return parsed;
}

/**
 * Admin endpoints for API key lifecycle (issue #441).
 *
 * Key creation and rotation are privileged operations — they require an admin
 * key (`x-admin-key`). The plaintext secret is returned exactly once at
 * creation/rotation and is never persisted or logged.
 */
@ApiTags("admin")
@Controller({ path: "admin/api-keys", version: "1" })
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class ApiKeyController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly solverCredentials?: SolverCredentialService,
  ) {}

  @Post()
  @ApiOperation({
    summary: "Create a new API key",
    description:
      "Creates an API key with the given tier. The plaintext secret is returned " +
      "ONCE in `plaintext` — it cannot be recovered later because only its " +
      "SHA-256 hash is stored.",
  })
  @ApiCreatedResponse({ description: "Key created (plaintext shown once)" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async create(@Body() dto: CreateApiKeyDto) {
    const { record, plaintext } = await this.apiKeys.createKey({
      tier: dto.tier,
      owner: dto.owner,
      scopes: dto.scopes,
      expiresAt: dto.expiresAt ?? null,
    });
    return {
      id: record.id,
      keyPrefix: record.keyPrefix,
      tier: record.tier,
      owner: record.owner,
      scopes: record.scopes,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      plaintext,
    };
  }

  @Post(":id/rotate")
  @ApiOperation({
    summary: "Rotate an API key",
    description:
      "Revokes the key with the given id and issues a replacement. The new " +
      "plaintext secret is returned ONCE. The old key stops working immediately.",
  })
  @ApiOkResponse({ description: "Key rotated (new plaintext shown once)" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async rotate(@Param("id") id: string, @Body() dto: RotateApiKeyDto) {
    const current = await this.apiKeys.getKey(id);
    if (!current) {
      await this.apiKeys.revokeKey(id);
      throw new Error(`API key not found: ${id}`);
    }
    await this.apiKeys.revokeKey(id);
    const { record, plaintext } = await this.apiKeys.createKey({
      tier: current.tier,
      owner: current.owner,
      scopes: dto.scopes ?? current.scopes ?? [],
      expiresAt: current.expiresAt ?? null,
    });
    return {
      id: record.id,
      keyPrefix: record.keyPrefix,
      tier: record.tier,
      owner: record.owner,
      scopes: record.scopes,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      plaintext,
    };
  }

  @Post(":id/revoke")
  @ApiOperation({
    summary: "Revoke an API key",
    description: "Instantly revokes the key. Revoked keys cannot authenticate.",
  })
  @ApiOkResponse({ description: "Key revoked" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async revoke(@Param("id") id: string) {
    await this.apiKeys.revokeKey(id);
    return { revoked: true, id };
  }

  @Get(":id/usage")
  @ApiOperation({
    summary: "Report per-key request volume",
    description:
      "Returns hourly request buckets for the key, split into allowed vs " +
      "throttled (429) counts. `from`/`to` accept ISO-8601 timestamps or epoch " +
      "seconds; both default to the last 24 hours.",
  })
  @ApiQuery({ name: "from", required: false, description: "ISO-8601 or epoch seconds" })
  @ApiQuery({ name: "to", required: false, description: "ISO-8601 or epoch seconds" })
  @ApiOkResponse({ description: "Bucketed usage counts" })
  @ApiBadRequestResponse({ description: "Invalid from/to" })
  @ApiNotFoundResponse({ description: "API key not found" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async usage(
    @Param("id") id: string,
    @Query("from") fromRaw?: string,
    @Query("to") toRaw?: string,
  ) {
    const to = parseTimestamp(toRaw, "to") ?? new Date();
    const from = parseTimestamp(fromRaw, "from") ?? new Date(to.getTime() - DEFAULT_USAGE_WINDOW_MS);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException("from must be before to");
    }
    const usage = await this.apiKeys.getUsage(id, from, to);
    return {
      id,
      from: from.toISOString(),
      to: to.toISOString(),
      buckets: usage.buckets.map((b) => ({
        start: b.start.toISOString(),
        allowed: b.allowed,
        throttled: b.throttled,
      })),
      totals: usage.totals,
    };
  }

  @Get("credentials/expiring-soon")
  @ApiOperation({
    summary: "List credentials expiring soon",
    description:
      "Returns API keys and solver credentials whose `expiresAt` falls inside " +
      "the warning window (default 7 days).",
  })
  @ApiQuery({ name: "windowDays", required: false, description: "Warning window in days (default 7)" })
  @ApiOkResponse({ description: "Credentials expiring within the window" })
  @ApiBadRequestResponse({ description: "Invalid windowDays" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async expiringSoon(@Query("windowDays") windowDaysRaw?: string) {
    let windowDays = DEFAULT_EXPIRY_WINDOW_DAYS;
    if (windowDaysRaw !== undefined && windowDaysRaw !== "") {
      const parsed = Number(windowDaysRaw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_EXPIRY_WINDOW_DAYS) {
        throw new BadRequestException(
          `windowDays must be an integer between 0 and ${MAX_EXPIRY_WINDOW_DAYS}`,
        );
      }
      windowDays = parsed;
    }
    const now = new Date();
    const until = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const [apiKeys, solverCredentials] = await Promise.all([
      this.apiKeys.findExpiringBetween(now, until),
      this.solverCredentials ? this.solverCredentials.findExpiringBetween(now, until) : Promise.resolve([]),
    ]);
    return {
      windowDays,
      from: now.toISOString(),
      to: until.toISOString(),
      apiKeys: apiKeys.map((k) => ({
        id: k.id,
        keyPrefix: k.keyPrefix,
        tier: k.tier,
        owner: k.owner,
        expiresAt: k.expiresAt,
      })),
      solverCredentials: solverCredentials.map((c) => ({
        id: c.id,
        solverId: c.solverId,
        expiresAt: c.expiresAt,
      })),
    };
  }

  @Get()
  @ApiOperation({
    summary: "List API keys",
    description:
      "Lists key metadata (never plaintext). Filter by owner with ?owner=.",
  })
  @ApiQuery({ name: "owner", required: false })
  @ApiOkResponse({ description: "Key metadata list" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async list(@Query("owner") owner?: string) {
    const keys = owner
      ? await this.apiKeys.listKeys(owner)
      : await this.apiKeys.listKeys("");
    return {
      keys: keys.map((k) => ({
        id: k.id,
        keyPrefix: k.keyPrefix,
        tier: k.tier,
        owner: k.owner,
        scopes: k.scopes,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
        expiresAt: k.expiresAt,
        lastUsedAt: k.lastUsedAt,
      })),
      count: keys.length,
    };
  }
}
