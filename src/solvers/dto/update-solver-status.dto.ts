import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class UpdateSolverStatusDto {
  @ApiProperty({ description: "Proof-of-control signature for the solver status update", maxLength: 88 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(88)
  signature!: string;
}
