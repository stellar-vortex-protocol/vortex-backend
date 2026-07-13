import { IsString, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class AcceptIntentDto {
  @ApiProperty({ description: "Solver address accepting the intent" })
  @IsString()
  @MinLength(5)
  solver!: string;
}
