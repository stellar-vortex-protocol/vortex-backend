import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsOptional, IsString } from "class-validator";

/** DTO for rotating an API key (issue #441). */
export class RotateApiKeyDto {
  @ApiPropertyOptional({
    type: [String],
    description: "Scope strings for the rotated key (defaults to the current key's scopes)",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];
}
