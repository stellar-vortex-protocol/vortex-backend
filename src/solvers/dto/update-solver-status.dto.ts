import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class UpdateSolverStatusDto {
  @ApiProperty({ description: "Proof-of-control signature for the solver status update" })
  @IsString()
  @IsNotEmpty()
  signature!: string;
}
