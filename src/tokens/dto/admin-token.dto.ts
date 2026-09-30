import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength } from "class-validator";
import { SUPPORTED_CHAINS } from "../../intents/intents.types";
import { TokenStatus } from "../tokens.repository";

export class CreateAdminTokenDto {
  @IsIn(SUPPORTED_CHAINS)
  chain!: string;

  @IsString()
  @MinLength(1)
  address!: string;

  @IsOptional()
  @IsString()
  symbol?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(255)
  decimals?: number;

  @IsOptional()
  @IsString()
  logoUri?: string;

  @IsOptional()
  @IsNumber()
  priceUSD?: number;
}

export class PatchAdminTokenDto {
  @IsIn(SUPPORTED_CHAINS)
  chain!: string;

  @IsString()
  @MinLength(1)
  address!: string;

  @IsOptional()
  @IsIn(["active", "paused", "delisted"])
  status?: TokenStatus;

  @IsOptional()
  @IsString()
  symbol?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(255)
  decimals?: number;

  @IsOptional()
  @IsString()
  logoUri?: string;

  @IsOptional()
  @IsNumber()
  priceUSD?: number;
}

export class DeleteAdminTokenDto {
  @IsIn(SUPPORTED_CHAINS)
  chain!: string;

  @IsString()
  @MinLength(1)
  address!: string;
}
