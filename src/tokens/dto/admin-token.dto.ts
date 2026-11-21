import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateAdminTokenDto {
  @ApiProperty({ description: 'Chain identifier the token lives on', example: 'ethereum' })
  @IsString()
  @Length(1, 64)
  chain!: string;

  @ApiProperty({ description: 'Token contract address', example: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' })
  @IsString()
  @Length(1, 128)
  address!: string;

  @ApiProperty({ description: 'Token symbol', example: 'USDC' })
  @IsString()
  @Length(1, 32)
  symbol!: string;

  @ApiProperty({ description: 'Token decimals', example: 6 })
  @IsInt()
  @Min(0)
  decimals!: number;

  @ApiPropertyOptional({ description: 'Whether the token is enabled for solving', example: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export const MAX_BATCH_ADMIN_TOKENS = 50;

export class BatchCreateAdminTokensDto {
  @ApiProperty({
    description: `Tokens to register (max ${MAX_BATCH_ADMIN_TOKENS} per call)`,
    type: [CreateAdminTokenDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_ADMIN_TOKENS)
  @ValidateNested({ each: true })
  @Type(() => CreateAdminTokenDto)
  tokens!: CreateAdminTokenDto[];
}
