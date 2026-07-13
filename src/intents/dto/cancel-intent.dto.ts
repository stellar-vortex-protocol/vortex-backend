import { IsString, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CancelIntentDto {
  @ApiProperty({ description: "Stellar address of the intent's original creator (must match)" })
  @IsString()
  @MinLength(10)
  user!: string;
}
