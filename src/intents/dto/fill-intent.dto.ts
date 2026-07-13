import { IsOptional, IsString, Matches, MinLength } from "class-validator";

export class FillIntentDto {
  @IsString()
  @MinLength(5)
  solver!: string;

  @IsString()
  @Matches(/^\d+$/)
  fillAmount!: string;

  @IsOptional()
  @IsString()
  txHash?: string;
}
