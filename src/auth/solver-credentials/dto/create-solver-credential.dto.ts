import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsIn, IsInt, IsOptional, IsString, ArrayNotEmpty, ArrayUnique } from "class-validator";
import { SOLVER_SCOPES } from "../solver-scopes";

/** DTO for creating a scoped solver credential (issue #443). */
export class CreateSolverCredentialDto {
  @ApiProperty({
    enum: SOLVER_SCOPES,
    description: "Scopes granted to the credential",
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(SOLVER_SCOPES, { each: true })
  scopes!: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      "Optional source-address allowlist. Entries are an exact IPv4 address, " +
      "an IPv4 CIDR block, an exact IPv6 address, or `*` for any source. " +
      "IPv6 CIDR blocks and hostnames are not supported; an entry that does " +
      "not parse never matches, so a typo locks the credential out rather " +
      "than opening it up.",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ipAllowlist?: string[];

  @ApiPropertyOptional({
    description: "Unix epoch seconds at which the credential expires (null = never)",
  })
  @IsOptional()
  @IsInt()
  expiresAt?: number;
}
