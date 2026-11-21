import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IntentType } from '../intents.types';

export enum DutchAuctionCurve {
  LINEAR = 'linear',
  EXPONENTIAL = 'exponential',
  STEPPED = 'stepped',
}

export class CreateDutchAuctionDto {
  @IsInt()
  @Min(0)
  decayStart!: number;

  @IsInt()
  @Min(0)
  decayEnd!: number;

  @IsString()
  @IsNotEmpty()
  startDstAmount!: string;

  @IsString()
  @IsNotEmpty()
  minDstAmount!: string;

  @IsOptional()
  @IsEnum(DutchAuctionCurve)
  curve?: DutchAuctionCurve;

  @IsOptional()
  @IsNumber()
  @Min(1)
  decayExponent?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  steps?: number;
}

export class CreateIntentDto {
  @IsEnum(IntentType)
  type!: IntentType;

  @IsString()
  @IsNotEmpty()
  srcChain!: string;

  @IsString()
  @IsNotEmpty()
  dstChain!: string;

  @IsString()
  @IsNotEmpty()
  srcToken!: string;

  @IsString()
  @IsNotEmpty()
  dstToken!: string;

  @IsString()
  @IsNotEmpty()
  srcAmount!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateDutchAuctionDto)
  dutchAuction?: CreateDutchAuctionDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  exclusiveSolvers?: string[];
}
