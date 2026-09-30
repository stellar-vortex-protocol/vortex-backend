import { Type } from "class-transformer";
import { IsArray, IsOptional, IsString, ValidateNested } from "class-validator";

export class DisputeEvidenceDto {
  @IsArray()
  @IsString({ each: true })
  txHashes: string[] = [];

  @IsArray()
  @IsString({ each: true })
  logs: string[] = [];

  @IsOptional()
  @IsString()
  note?: string;
}

export class SubmitDisputeDto {
  @IsString()
  slashId!: string;

  @IsString()
  reason!: string;

  /** Ed25519 signature over `dispute:<slashId>:<address>:<reason>`. */
  @IsString()
  signature!: string;

  @ValidateNested()
  @Type(() => DisputeEvidenceDto)
  evidence!: DisputeEvidenceDto;
}
