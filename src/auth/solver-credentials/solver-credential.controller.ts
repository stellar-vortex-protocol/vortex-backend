import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { Request } from "express";
import { SolverCredentialService } from "./solver-credential.service";
import { CreateSolverCredentialDto } from "./dto/create-solver-credential.dto";
import { SolverJwtGuard } from "./solver-jwt.guard";

/**
 * Scoped solver credential endpoints (issue #443).
 *
 * Every endpoint requires a valid SEP-10 JWT (`Authorization: Bearer`) whose
 * `sub` is the solver's on-chain address (enforced by {@link SolverJwtGuard}).
 * Credentials can only be minted for the authenticated solver.
 */
@ApiTags("solvers")
@Controller("api/v1/solvers/:address/credentials")
@UseGuards(SolverJwtGuard)
export class SolverCredentialController {
  constructor(private readonly credentials: SolverCredentialService) {}

  @Post()
  @ApiOperation({
    summary: "Create a scoped solver credential",
    description:
      "Mints a new scoped credential for the authenticated solver. The plaintext " +
      "secret is returned ONCE. Requires a valid SEP-10 JWT for the solver.",
  })
  @ApiCreatedResponse({ description: "Credential created (plaintext shown once)" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid SEP-10 JWT" })
  async create(@Req() req: Request, @Param("address") address: string, @Body() dto: CreateSolverCredentialDto) {
    const { record, plaintext } = await this.credentials.createCredential({
      solverAddress: address,
      scopes: dto.scopes,
      ipAllowlist: dto.ipAllowlist ?? null,
      expiresAt: dto.expiresAt ?? null,
    });
    return {
      id: record.id,
      credPrefix: record.credPrefix,
      solverAddress: record.solverAddress,
      scopes: record.scopes,
      ipAllowlist: record.ipAllowlist,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      plaintext,
    };
  }

  @Post(":id/rotate")
  @ApiOperation({
    summary: "Rotate a solver credential",
    description:
      "Revokes the credential and issues a replacement with the same scopes. " +
      "The new plaintext is returned ONCE.",
  })
  @ApiOkResponse({ description: "Credential rotated (new plaintext shown once)" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid SEP-10 JWT" })
  async rotate(@Param("address") address: string, @Param("id") id: string, @Body() dto: CreateSolverCredentialDto) {
    const current = await this.credentials.listCredentials(address);
    if (!current.some((c) => c.id === id)) {
      throw new BadRequestException("Credential not found for this solver");
    }
    const rotated = await this.credentials.rotateCredential(id, dto.scopes);
    if (!rotated) {
      throw new BadRequestException("Credential not found");
    }
    return {
      id: rotated.record.id,
      credPrefix: rotated.record.credPrefix,
      scopes: rotated.record.scopes,
      createdAt: rotated.record.createdAt,
      expiresAt: rotated.record.expiresAt,
      plaintext: rotated.plaintext,
    };
  }

  @Post(":id/revoke")
  @ApiOperation({
    summary: "Revoke a solver credential",
    description: "Instantly revokes the credential and propagates to all replicas.",
  })
  @ApiOkResponse({ description: "Credential revoked" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid SEP-10 JWT" })
  async revoke(@Param("address") address: string, @Param("id") id: string) {
    const current = await this.credentials.listCredentials(address);
    if (!current.some((c) => c.id === id)) {
      throw new BadRequestException("Credential not found for this solver");
    }
    await this.credentials.revokeCredential(id, "revoked");
    return { revoked: true, id };
  }

  @Get()
  @ApiOperation({
    summary: "List a solver's credentials",
    description: "Lists credential metadata (never plaintext) for the authenticated solver.",
  })
  @ApiOkResponse({ description: "Credential metadata list" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid SEP-10 JWT" })
  async list(@Param("address") address: string) {
    const credentials = await this.credentials.listCredentials(address);
    return {
      credentials: credentials.map((c) => ({
        id: c.id,
        credPrefix: c.credPrefix,
        scopes: c.scopes,
        ipAllowlist: c.ipAllowlist,
        createdAt: c.createdAt,
        expiresAt: c.expiresAt,
        revokedAt: c.revokedAt,
        rotatedAt: c.rotatedAt,
        lastUsedAt: c.lastUsedAt,
      })),
      count: credentials.length,
    };
  }
}
