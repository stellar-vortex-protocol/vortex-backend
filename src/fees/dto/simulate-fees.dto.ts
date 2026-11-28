import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * Maximum number of sample trades accepted per simulation request.
 * Bounds the endpoint so it cannot be used as an unbounded compute sink.
 */
export const MAX_SIMULATE_INPUTS = 100;

export class SimulateFeeTierDto {
  @IsNumber()
  upTo!: number;

  @IsNumber()
  rate!: number;
}

export class SimulateFeeRuleDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsOptional()
  @IsString()
  pair?: string;

  @IsOptional()
  @IsString()
  chain?: string;

  @IsOptional()
  @IsString()
  asset?: string;

  @IsNumber()
  baseRate!: number;

  @IsOptional()
  @IsNumber()
  minFee?: number;

  @IsOptional()
  @IsNumber()
  maxFee?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SimulateFeeTierDto)
  tiers?: SimulateFeeTierDto[];

  @IsOptional()
  @IsNumber()
  priority?: number;
}

export class SimulateReferralCodeDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsNumber()
  discountRate!: number;
}

export class SimulateFeeInputDto {
  @IsOptional()
  @IsString()
  pair?: string;

  @IsOptional()
  @IsString()
  chain?: string;

  @IsOptional()
  @IsString()
  asset?: string;

  @IsNumber()
  amount!: number;

  @IsOptional()
  @IsString()
  referralCode?: string;
}

export class SimulateFeesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SimulateFeeRuleDto)
  rules!: SimulateFeeRuleDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SimulateReferralCodeDto)
  referralCodes?: SimulateReferralCodeDto[];

  @IsArray()
  @ArrayMaxSize(MAX_SIMULATE_INPUTS)
  @ValidateNested({ each: true })
  @Type(() => SimulateFeeInputDto)
  inputs!: SimulateFeeInputDto[];
}
