import { IsString, MinLength } from "class-validator";

export class AcceptIntentDto {
  @IsString()
  @MinLength(5)
  solver!: string;
}
