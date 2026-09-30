import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { AdminGuard, RequireAdminRole } from "../../admin/admin.guard";
import { ApiKeyService } from "./api-key.service";
import { CreateApiKeyDto } from "./dto/create-api-key.dto";
import { RotateApiKeyDto } from "./dto/rotate-api-key.dto";

/**
 * Admin endpoints for API key lifecycle (issue #441).
 *
 * Key creation and rotation are privileged operations — they require an admin
 * key (`x-admin-key`). The plaintext secret is returned exactly once at
 * creation/rotation and is never persisted or logged.
 */
@ApiTags("admin")
@Controller("api/v1/admin/api-keys")
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class ApiKeyController {
  constructor(private readonly apiKeys: ApiKeyService) {}

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
