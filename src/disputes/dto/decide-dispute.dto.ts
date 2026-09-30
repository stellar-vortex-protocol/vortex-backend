import { IsIn, IsString } from "class-validator";
import { DisputeResolution } from "../disputes.types";

export class DecideDisputeDto {
  @IsIn(["upheld", "overturned"])
  resolution!: DisputeResolution;

  @IsString()
  reason!: string;
}
