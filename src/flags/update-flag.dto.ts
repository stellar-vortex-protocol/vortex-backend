import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { SUPPORTED_CHAINS } from "../intents/intents.types";

export class FlagRuleDto {
  @IsBoolean()
  value!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  percentage?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  solvers?: string[];

  @IsOptional()
  @IsArray()
  @IsIn(SUPPORTED_CHAINS, { each: true })
  chains?: string[];
}

export class UpdateFlagDto {
  @IsBoolean()
  defaultValue!: boolean;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FlagRuleDto)
  rules!: FlagRuleDto[];

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
