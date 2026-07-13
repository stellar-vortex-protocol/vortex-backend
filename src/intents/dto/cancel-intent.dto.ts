import { IsString, MinLength } from "class-validator";

export class CancelIntentDto {
  @IsString()
  @MinLength(10)
  user!: string;
}
