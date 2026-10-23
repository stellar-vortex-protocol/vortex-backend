import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { ALLOWLIST_ENTRY_TYPES, AllowlistEntryType } from "../allowlist.service";

/** Body of `POST /api/v1/abuse/allowlist`. */
export class CreateAllowlistEntryDto {
  @ApiProperty({ enum: ALLOWLIST_ENTRY_TYPES })
  @IsIn(ALLOWLIST_ENTRY_TYPES)
  type!: AllowlistEntryType;

  @ApiProperty({
    description:
      "Stellar G-address, exact IPv4/IPv6 address (no CIDR), or a raw API key. API keys are SHA-256 hashed before storage and never returned.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  value!: string;

  @ApiPropertyOptional({ description: "Who the entry is for, e.g. the integrator name" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}
