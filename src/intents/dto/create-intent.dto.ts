import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SUPPORTED_CHAINS, SupportedChain } from "../intents.types";
import { IsValidAddress } from "../../common/validators/is-valid-address.validator";
import { IsValidDeadline } from "../../common/validators/deadline.validator";

function IsNotSelfSwap(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isNotSelfSwap",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const obj = args.object as Record<string, unknown>;
          const srcChain = obj.srcChain;
          const srcTokenAddress = obj.srcTokenAddress;
          const dstTokenContract = value;

          return !(srcChain === "stellar" && srcTokenAddress === dstTokenContract);
        },
        defaultMessage() {
          return "Self-swaps are not allowed: a Stellar asset cannot be swapped against itself on the same chain";
        },
      },
    });
  };
}

export class CreateIntentDto {
  @ApiProperty({ description: "Stellar address of the user creating the intent", maxLength: 56 })
  @IsString()
  @MinLength(10)
  @MaxLength(56)
  user!: string;

  @ApiProperty({ enum: SUPPORTED_CHAINS, description: "Source chain the funds are coming from" })
  @IsIn(SUPPORTED_CHAINS)
  srcChain!: SupportedChain;

  @ApiProperty({ description: "Source token contract/address on srcChain" })
  @IsValidAddress()
  srcTokenAddress!: string;

  @ApiProperty({ description: "Source token symbol, e.g. USDC", maxLength: 16 })
  @IsString()
  @MaxLength(16)
  srcTokenSymbol!: string;

  @ApiProperty({ minimum: 0, maximum: 18, description: "Source token decimals" })
  @IsInt()
  @Min(0)
  @Max(18)
  srcTokenDecimals!: number;

  @ApiProperty({ description: "Source amount as a non-negative integer string (base units)" })
  @IsString()
  @Matches(/^\d+$/)
  srcAmount!: string;

  @ApiProperty({ description: "Destination Stellar token contract", maxLength: 56 })
  @IsString()
  @Matches(/^[A-Z0-9]{56}$/)
  @MaxLength(56)
  @IsNotSelfSwap()
  dstTokenContract!: string;

  @ApiProperty({ description: "Destination token symbol, e.g. USDC", maxLength: 16 })
  @IsString()
  @MaxLength(16)
  dstTokenSymbol!: string;

  @ApiProperty({ minimum: 0, maximum: 18, description: "Destination token decimals" })
  @IsInt()
  @Min(0)
  @Max(18)
  dstTokenDecimals!: number;

  @ApiProperty({ description: "Minimum acceptable destination amount as an integer string" })
  @IsString()
  @Matches(/^\d+$/)
  minDstAmount!: string;

  @ApiPropertyOptional({ description: "Unix timestamp deadline; defaults to now + 1800s; must be between now+60s and now+24h" })
  @IsOptional()
  @IsInt()
  @IsValidDeadline()
  deadline?: number;

  @ApiPropertyOptional({ description: "Idempotency key for deduplicating duplicate requests" })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
